import { eq } from "drizzle-orm";
import { Duration, Effect, Layer, ManagedRuntime, Schedule } from "effect";
import { WorkflowEngine } from "effect/unstable/workflow";
import { afterAll, describe, expect, it, vi } from "vitest";
import { layer as databaseLayer, query } from "../../database/database.ts";
import { unimplemented } from "../../testing.ts";
import { Lanes } from "../../workflows/lanes.ts";
import { lane } from "../../workflows/sql.ts";
import { ModelRequestFailed, Models } from "../turns/model.ts";
import { TurnRepository } from "../turns/repository.ts";
import { TurnRequests } from "../turns/requests.ts";
import { Summaries } from "./summaries.ts";
import { stepsLayer } from "./summary.steps.ts";
import { Summary, type SummaryRequest, summaryLane, summaryWorkflow } from "./summary.workflow.ts";

const prepare = vi.fn(() =>
	Effect.succeed({ _tag: "Skipped" as const, reason: "already summarised" }),
);

const runtime = ManagedRuntime.make(
	summaryWorkflow.layer.pipe(
		Layer.provideMerge(
			stepsLayer.pipe(
				Layer.provide(
					Layer.succeed(Models, {
						stream: () =>
							Effect.fail(new ModelRequestFailed({ message: "unused", reason: "unavailable" })),
					}),
				),
			),
		),
		Layer.provide(unimplemented(Summaries.Service, { prepare })),
		Layer.provide(unimplemented(TurnRepository.Service)),
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
			Effect.flatMap(TurnRequests.make, (requests) => requests.queueSummary(request)),
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
		expect(prepare).toHaveBeenCalledWith(request);
	});
});
