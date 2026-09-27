import { sql } from "drizzle-orm";
import { Duration, Effect, Exit, Layer, ManagedRuntime, Option, Schedule, Schema } from "effect";
import { DurableDeferred, Workflow, WorkflowEngine } from "effect/unstable/workflow";
import { afterAll, describe, expect, it } from "vitest";
import { layer as databaseLayer, query, transaction } from "../database/database.ts";
import { Outbox } from "./outbox.ts";
import { workflowOutbox } from "./sql.ts";

// The value crosses as its encoding; a number sent as a string proves the
// workflow decodes it with its own deferred's schema.
const Answer = DurableDeferred.make("answer", { success: Schema.NumberFromString });

const Waiting = Workflow.make("test/outbox-waiting", {
	payload: { key: Schema.String },
	success: Schema.Finite,
	idempotencyKey: (payload) => payload.key,
});

const runtime = ManagedRuntime.make(
	Outbox.layer([Waiting]).pipe(
		Layer.provideMerge(Waiting.toLayer(() => DurableDeferred.await(Answer))),
		Layer.provideMerge(WorkflowEngine.layerMemory),
		Layer.provideMerge(databaseLayer),
	),
);
afterAll(() => runtime.dispose());

const outbox = () => runtime.runPromise(Effect.service(Outbox.Service));

/** Starts a waiting execution and returns its id once it has suspended. */
const waitingExecution = async () => {
	const executionId = await runtime.runPromise(
		Waiting.execute({ key: crypto.randomUUID() }, { discard: true }),
	);
	await runtime.runPromise(
		Waiting.poll(executionId).pipe(
			Effect.flatMap((result) =>
				Option.isSome(result) && result.value._tag === "Suspended"
					? Effect.void
					: Effect.fail("running"),
			),
			Effect.retry({ times: 100, schedule: Schedule.spaced(Duration.millis(20)) }),
		),
	);
	return executionId;
};

const completion = (executionId: string) =>
	runtime.runPromise(
		Waiting.poll(executionId).pipe(
			Effect.flatMap((result) =>
				Option.isSome(result) && result.value._tag === "Complete"
					? Effect.succeed(result.value.exit)
					: Effect.fail("waiting"),
			),
			Effect.retry({ times: 100, schedule: Schedule.spaced(Duration.millis(20)) }),
		),
	);

const undelivered = () => runtime.runPromise(query((db) => db.select().from(workflowOutbox)));

describe.skipIf(!process.env.DATABASE_URL)("the workflow outbox", () => {
	it("delivers a signal once its transaction commits, and forgets it", async () => {
		const executionId = await waitingExecution();
		const service = await outbox();

		await runtime.runPromise(
			service.signal({ workflow: Waiting, executionId, deferred: Answer, exit: Exit.succeed(42) }),
		);

		expect(await completion(executionId)).toEqual(Exit.succeed(42));
		expect((await undelivered()).filter((row) => row.executionId === executionId)).toEqual([]);
	});

	it("sends nothing when the transaction that recorded it rolls back", async () => {
		const executionId = await waitingExecution();
		const service = await outbox();

		await runtime
			.runPromise(
				transaction(
					service
						.signal({ workflow: Waiting, executionId, deferred: Answer, exit: Exit.succeed(1) })
						.pipe(Effect.andThen(Effect.fail("rolled back"))),
				),
			)
			.catch(() => undefined);

		const result = await runtime.runPromise(Waiting.poll(executionId));
		expect(Option.isSome(result) && result.value._tag).toBe("Suspended");
		expect((await undelivered()).filter((row) => row.executionId === executionId)).toEqual([]);
	});

	it("interrupts an execution", async () => {
		const executionId = await waitingExecution();
		const service = await outbox();

		await runtime.runPromise(service.interrupt({ workflow: Waiting, executionId }));

		expect(Exit.hasInterrupts(await completion(executionId))).toBe(true);
	});

	it("sends again a message a crash left behind", async () => {
		const executionId = await waitingExecution();
		await runtime.runPromise(
			query((db) =>
				db.insert(workflowOutbox).values({
					kind: "signal",
					workflow: Waiting._tag,
					executionId,
					deferred: Answer.name,
					exit: { _tag: "Success", value: "7" },
					createdAt: sql`now() - interval '1 minute'`,
				}),
			),
		);

		await runtime.runPromise((await outbox()).reconcile);

		expect(await completion(executionId)).toEqual(Exit.succeed(7));
	});
});
