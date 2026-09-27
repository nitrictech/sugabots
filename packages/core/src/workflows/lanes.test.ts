import { eq, sql } from "drizzle-orm";
import { Effect, Layer, ManagedRuntime, Option, Schema } from "effect";
import { DurableDeferred, Workflow, WorkflowEngine } from "effect/unstable/workflow";
import { afterAll, describe, expect, it } from "vitest";
import { layer as databaseLayer, query } from "../database/database.ts";
import { Lanes } from "./lanes.ts";
import { lane, laneRequest } from "./sql.ts";

const Held = Workflow.make("test/lane-held", {
	payload: { key: Schema.String, request: Schema.String },
	idempotencyKey: (payload) => `${payload.key}/${payload.request}`,
});

// Holds its lane until the test releases it.
const Forever = DurableDeferred.make("forever");
const HeldLive = Held.toLayer(() => DurableDeferred.await(Forever));

const runtime = ManagedRuntime.make(
	Lanes.layer([Held]).pipe(
		Layer.provideMerge(HeldLive),
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
});
