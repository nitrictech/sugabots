import { Activities } from "@sugabots/workflow/activities";
import { eq, sql } from "drizzle-orm";
import { Context, Duration, Effect, Layer, ManagedRuntime, Option, Schedule, Schema } from "effect";
import { DurableDeferred, Workflow, WorkflowEngine } from "effect/unstable/workflow";
import { afterAll, describe, expect, it, vi } from "vitest";
import { type Database, layer as databaseLayer, query } from "../database/database.ts";
import { Lanes } from "./lanes.ts";
import { lane, laneRequest } from "./sql.ts";

const Held = Workflow.make("test/lane-held", {
	payload: { key: Schema.String, request: Schema.String },
	idempotencyKey: (payload) => `${payload.key}/${payload.request}`,
});

// Holds its lane until the test releases it.
const Forever = DurableDeferred.make("forever");
const HeldLive = Held.toLayer(() => DurableDeferred.await(Forever));

// Finishes at once, without releasing its lane.
const Done = Workflow.make("test/lane-done", {
	payload: { key: Schema.String, request: Schema.String },
	idempotencyKey: (payload) => `${payload.key}/${payload.request}`,
});
const DoneLive = Done.toLayer(() => Effect.void);

// Waits to be told to go, then ends as its payload says, recording its ending.
const Ending = Workflow.make("test/lane-ending", {
	payload: { key: Schema.String, fails: Schema.Boolean },
	idempotencyKey: (payload) => payload.key,
});
const Go = DurableDeferred.make("go");
const endings: string[] = [];

class EndingSteps extends Context.Service<
	EndingSteps,
	{
		readonly recordFailure: (payload: typeof Ending.payloadSchema.Type) => Effect.Effect<void>;
		readonly recordReleased: (payload: typeof Ending.payloadSchema.Type) => Effect.Effect<void>;
	}
>()("test/EndingSteps") {}

const endingActivities = Activities.fromService<typeof Ending.payloadSchema.Type>()(EndingSteps, {
	recordFailure: {},
	recordReleased: {},
});

/** Records `event` with the state its lane is in at that moment. */
const recordEnding = (key: string, event: string) =>
	query((db) => db.select({ state: lane.state }).from(lane).where(eq(lane.key, key))).pipe(
		Effect.flatMap(([row]) =>
			Effect.sync(() => {
				endings.push(`${event}:${row?.state}`);
			}),
		),
	);

const EndingWorkflow = Lanes.workflow(Ending, {
	lane: (payload) => payload.key,
	activities: endingActivities,
	body: (payload) =>
		DurableDeferred.await(Go).pipe(
			Effect.andThen(payload.fails ? Effect.die(new Error("failed")) : Effect.void),
		),
	onFailure: "recordFailure",
	onReleased: "recordReleased",
});

const endingSteps = Layer.effect(
	EndingSteps,
	Effect.map(Effect.context<Database>(), (database) =>
		EndingSteps.of({
			recordFailure: ({ key }) =>
				recordEnding(key, "failure").pipe(Effect.provideContext(database)),
			recordReleased: ({ key }) =>
				recordEnding(key, "released").pipe(Effect.provideContext(database)),
		}),
	),
);

const runtime = ManagedRuntime.make(
	Layer.mergeAll(HeldLive, DoneLive, EndingWorkflow.layer).pipe(
		Layer.provideMerge(endingSteps),
		Layer.provideMerge(Lanes.layerFor([Held, Done, Ending])),
		Layer.provideMerge(WorkflowEngine.layerMemory),
		Layer.provideMerge(databaseLayer),
	),
);
const run = <A, E>(effect: Effect.Effect<A, E, Lanes.Service | WorkflowEngine.WorkflowEngine>) =>
	runtime.runPromise(effect);
const lanes = () => runtime.runPromise(Effect.service(Lanes.Service));

const laneOf = (key: string) =>
	runtime
		.runPromise(query((db) => db.select().from(lane).where(eq(lane.key, key))))
		.then(([row]) => row);
const waitingIn = (key: string) =>
	runtime.runPromise(
		query((db) => db.select().from(laneRequest).where(eq(laneRequest.laneKey, key))),
	);
const executionIdOf = (key: string, request: string) => run(Held.executionId({ key, request }));

afterAll(() => runtime.dispose());

describe.skipIf(!process.env.DATABASE_URL)("lanes", () => {
	it("starts the workflow when the lane is idle", async () => {
		const key = crypto.randomUUID();
		const service = await lanes();

		expect(
			await run(
				service.admit({ key, workflow: Held, payload: { key, request: "a" }, whenBusy: "queue" }),
			),
		).toBe("started");
		const row = await laneOf(key);
		expect(row).toMatchObject({
			state: "running",
			workflow: Held._tag,
			executionId: await executionIdOf(key, "a"),
		});
		const polled = await run(Held.poll(row?.executionId ?? ""));
		expect(Option.isSome(polled) && polled.value._tag).toBe("Suspended");
	});

	it("makes a request wait, coalesce or replace while the lane is busy", async () => {
		const key = crypto.randomUUID();
		const service = await lanes();
		const admit = (request: string, whenBusy: Lanes.WhenBusy) =>
			run(service.admit({ key, workflow: Held, payload: { key, request }, whenBusy }));

		await admit("running", "queue");
		expect(await admit("first", "coalesce")).toBe("waiting");
		expect(await admit("second", "coalesce")).toBe("coalesced");
		expect(await admit("third", "replace")).toBe("replaced");
		expect(await admit("fourth", "queue")).toBe("waiting");

		expect(
			(await waitingIn(key)).map((row) => (row.payload as { request: string }).request),
		).toEqual(["third", "fourth"]);
	});

	it("hands the lane to the oldest waiting request on release, then goes idle", async () => {
		const key = crypto.randomUUID();
		const service = await lanes();
		for (const request of ["a", "b"]) {
			await run(
				service.admit({ key, workflow: Held, payload: { key, request }, whenBusy: "queue" }),
			);
		}

		await run(service.release({ key, executionId: await executionIdOf(key, "a") }));
		expect(await laneOf(key)).toMatchObject({
			state: "running",
			executionId: await executionIdOf(key, "b"),
		});
		expect(await waitingIn(key)).toEqual([]);

		await run(service.release({ key, executionId: await executionIdOf(key, "b") }));
		expect(await laneOf(key)).toMatchObject({ state: "idle", executionId: null });
	});

	it("drops a request for the execution that is releasing the lane", async () => {
		const key = crypto.randomUUID();
		const service = await lanes();
		const payload = { key, request: "same" };
		await run(service.admit({ key, workflow: Held, payload, whenBusy: "queue" }));
		expect(await run(service.admit({ key, workflow: Held, payload, whenBusy: "queue" }))).toBe(
			"waiting",
		);

		await run(service.release({ key, executionId: await executionIdOf(key, "same") }));

		expect(await laneOf(key)).toMatchObject({ state: "idle", executionId: null });
		expect(await waitingIn(key)).toEqual([]);
	});

	it("frees the lane at once when asked to run an execution that has finished", async () => {
		const key = crypto.randomUUID();
		const service = await lanes();
		const payload = { key, request: "finished" };
		await run(service.admit({ key, workflow: Done, payload, whenBusy: "queue" }));
		const executionId = await run(Done.executionId(payload));
		await run(
			Done.poll(executionId).pipe(
				Effect.flatMap((result) =>
					Option.isSome(result) && result.value._tag === "Complete"
						? Effect.void
						: Effect.fail("running"),
				),
				Effect.retry({ times: 100, schedule: Schedule.spaced(Duration.millis(10)) }),
			),
		);
		await run(service.release({ key, executionId }));

		await run(service.admit({ key, workflow: Done, payload, whenBusy: "queue" }));

		expect(await laneOf(key)).toMatchObject({ state: "idle", executionId: null });
	});

	it("ignores a release from an execution that no longer holds the lane", async () => {
		const key = crypto.randomUUID();
		const service = await lanes();
		await run(
			service.admit({ key, workflow: Held, payload: { key, request: "a" }, whenBusy: "queue" }),
		);

		await run(service.release({ key, executionId: await executionIdOf(key, "someone else") }));

		expect(await laneOf(key)).toMatchObject({
			state: "running",
			executionId: await executionIdOf(key, "a"),
		});
	});

	it("says whether work is under way about a subject", async () => {
		const key = crypto.randomUUID();
		const subject = crypto.randomUUID();
		const service = await lanes();
		const busy = () =>
			runtime
				.runPromise(
					query((db) =>
						db.execute<{ busy: boolean }>(
							sql`select ${Lanes.laneBusy(sql`${subject}`, [Held._tag])} as busy`,
							"objects",
						),
					),
				)
				.then(([row]) => row?.busy);

		expect(await busy()).toBe(false);
		await run(
			service.admit({
				key,
				subject,
				workflow: Held,
				payload: { key, request: "a" },
				whenBusy: "queue",
			}),
		);
		expect(await busy()).toBe(true);

		await run(service.release({ key, executionId: await executionIdOf(key, "a") }));
		expect(await busy()).toBe(false);
	});

	it("starts again a lane a crash left starting", async () => {
		const key = crypto.randomUUID();
		const executionId = await executionIdOf(key, "a");
		await runtime.runPromise(
			query((db) =>
				db.insert(lane).values({
					key,
					state: "starting",
					workflow: Held._tag,
					executionId,
					payload: { key, request: "a" },
					updatedAt: sql`now() - interval '1 minute'`,
				}),
			),
		);

		await run((await lanes()).reconcile);

		expect(await laneOf(key)).toMatchObject({ state: "running", executionId });
		const polled = await run(Held.poll(executionId));
		expect(Option.isSome(polled)).toBe(true);
	});

	describe("a lane workflow", () => {
		/** Starts an `Ending` execution in its lane, waiting until it suspends to wait for `Go`. */
		const startEnding = async (payload: typeof Ending.payloadSchema.Type) => {
			await run(
				(await lanes()).admit({ key: payload.key, workflow: Ending, payload, whenBusy: "queue" }),
			);
			const executionId = await run(Ending.executionId(payload));
			await vi.waitFor(async () => {
				const polled = await run(Ending.poll(executionId));
				expect(Option.isSome(polled) && polled.value._tag).toBe("Suspended");
			});
			return executionId;
		};
		const go = (executionId: string) =>
			run(
				DurableDeferred.succeed(Go, {
					token: DurableDeferred.tokenFromExecutionId(Go, { workflow: Ending, executionId }),
					value: undefined,
				}),
			);

		it("keeps its lane while suspended, and releases it when it ends", async () => {
			const key = crypto.randomUUID();
			endings.length = 0;
			const executionId = await startEnding({ key, fails: false });

			expect(await laneOf(key)).toMatchObject({ state: "running", executionId });

			await go(executionId);
			await vi.waitFor(() => expect(endings).toEqual(["released:idle"]));
			expect(await laneOf(key)).toMatchObject({ state: "idle", executionId: null });
		});

		it("rebuilds each of its activities, the lane's release included, from its full name", async () => {
			const key = crypto.randomUUID();
			const payload = { key, fails: false };
			const executionId = await startEnding(payload);
			expect(EndingWorkflow.resolve("recordFailure", payload)?.name).toBe("recordFailure");
			const release = EndingWorkflow.resolve("releaseLane", payload);
			expect(release?.name).toBe("releaseLane");

			await run(
				(release?.execute ?? Effect.die("unresolved")).pipe(
					Effect.provideService(
						WorkflowEngine.WorkflowInstance,
						WorkflowEngine.WorkflowInstance.initial(Ending, executionId),
					),
					Effect.scoped,
				) as Effect.Effect<unknown, unknown, Lanes.Service>,
			);

			expect(await laneOf(key)).toMatchObject({ state: "idle", executionId: null });
			expect(EndingWorkflow.resolve("unknown", payload)).toBeUndefined();
		});

		it("records a failure while it still holds its lane, then releases it", async () => {
			const key = crypto.randomUUID();
			endings.length = 0;
			await go(await startEnding({ key, fails: true }));

			await vi.waitFor(() => expect(endings).toEqual(["failure:running", "released:idle"]));
		});
	});
});
