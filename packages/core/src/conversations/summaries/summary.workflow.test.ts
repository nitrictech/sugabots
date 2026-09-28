import { eq } from "drizzle-orm";
import { Duration, Effect, Layer, ManagedRuntime, Schedule } from "effect";
import { WorkflowEngine } from "effect/unstable/workflow";
import { afterAll, describe, expect, it, vi } from "vitest";
import { layer as databaseLayer, query } from "../../database/database.ts";
import { Lanes } from "../../workflows/lanes.ts";
import { lane } from "../../workflows/sql.ts";
import { ModelRequestFailed } from "../turns/model.ts";
import { queueSummary, SummarySkipped, type SummaryStore } from "./store.ts";
import { Summary, type SummaryRequest, summaryLane, summaryWorkflow } from "./summary.workflow.ts";
import { stepsLayer } from "./worker.ts";

const store: SummaryStore = {
	prepare: vi.fn(() => Effect.fail(new SummarySkipped({ reason: "already summarised" }))),
	complete: vi.fn(() => Effect.void),
	fail: vi.fn(() => Effect.void),
};

const runtime = ManagedRuntime.make(
	summaryWorkflow.layer.pipe(
		Layer.provideMerge(
			stepsLayer({
				store,
				model: {
					stream: () =>
						Effect.fail(new ModelRequestFailed({ message: "unused", reason: "unavailable" })),
				},
			}),
		),
		Layer.provideMerge(Lanes.layer([Summary])),
		Layer.provideMerge(WorkflowEngine.layerMemory),
		Layer.provideMerge(databaseLayer),
	),
);

afterAll(() => runtime.dispose());

describe.skipIf(!process.env.DATABASE_URL)("the summary workflow", () => {
	it("summarises through the thread's lane and frees it afterwards", async () => {
		const request: SummaryRequest = {
			threadId: crypto.randomUUID(),
			agentId: crypto.randomUUID(),
			sourceMessageId: crypto.randomUUID(),
		};

		await runtime.runPromise(
			Effect.flatMap(Effect.service(Lanes.Service), (lanes) => queueSummary(lanes, request)),
		);

		const idle = await runtime.runPromise(
			query((db) =>
				db
					.select()
					.from(lane)
					.where(eq(lane.key, summaryLane(request))),
			).pipe(
				Effect.flatMap(([row]) =>
					row?.state === "idle" ? Effect.succeed(row) : Effect.fail("busy"),
				),
				Effect.retry({ times: 100, schedule: Schedule.spaced(Duration.millis(20)) }),
			),
		);
		expect(idle.executionId).toBeNull();
		expect(store.prepare).toHaveBeenCalledWith(request);
	});
});
