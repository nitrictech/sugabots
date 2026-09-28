import { eq } from "drizzle-orm";
import { Duration, Effect, Layer, ManagedRuntime, Schedule } from "effect";
import { WorkflowEngine } from "effect/unstable/workflow";
import { afterAll, describe, expect, it, vi } from "vitest";
import { layer as databaseLayer, query } from "../../database/database.ts";
import { Models } from "../../providers/models/models.ts";
import { unusedModel } from "../../providers/models/testing.ts";
import { unimplemented } from "../../testing.ts";
import { Lanes } from "../../workflows/lanes.ts";
import { lane } from "../../workflows/sql.ts";
import { Turns } from "../turns/turns.ts";
import { Summaries } from "./summaries.ts";
import { summaryStepsLayer } from "./summary.steps.ts";
import {
	admitSummary,
	Summary,
	type SummaryRequest,
	summaryLane,
	summaryWorkflow,
} from "./summary.workflow.ts";

const prepare = vi.fn(() =>
	Effect.succeed({ _tag: "Skipped" as const, reason: "already summarised" }),
);

const runtime = ManagedRuntime.make(
	summaryWorkflow.layer.pipe(
		Layer.provideMerge(
			summaryStepsLayer.pipe(Layer.provide(Layer.succeed(Models.Service, unusedModel()))),
		),
		Layer.provide(unimplemented(Summaries.Service, { prepare })),
		Layer.provide(unimplemented(Turns.Service)),
		Layer.provideMerge(Lanes.layerFor([Summary])),
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
			Effect.gen(function* () {
				const lanes = yield* Lanes.Service;
				yield* admitSummary(lanes, request);
			}),
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
