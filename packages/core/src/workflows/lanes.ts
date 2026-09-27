export * as Lanes from "./lanes.ts";

import { and, asc, eq, lt, type SQLWrapper, sql } from "drizzle-orm";
import { Context, Duration, Effect, Layer, Option, Schema } from "effect";
import { type Workflow, WorkflowEngine } from "effect/unstable/workflow";
import { afterCommit, Database, query, transaction } from "../database/database.ts";
import { lane, laneRequest } from "./sql.ts";

/**
 * Lanes run one workflow execution at a time per key, whichever engine runs
 * it, and hold the requests that arrive while one is running.
 *
 * A workflow is started only once the caller's transaction commits, so no
 * execution runs for a write that rolled back. Admitting a request records it
 * in the caller's transaction as `starting`; the workflow starts after commit.
 * Starting is idempotent, since the execution id comes from the payload, so
 * `reconcile` can safely start again any lane left `starting` by a crash.
 */
export interface Interface {
	/** Starts the workflow now if the lane is idle; otherwise leaves it to wait, by `whenBusy`. */
	readonly admit: <W extends Workflow.Any>(request: {
		readonly key: string;
		/** What the lane's work is about (a thread, say), for `laneBusy`. */
		readonly subject?: string;
		readonly workflow: W;
		readonly payload: W["payloadSchema"]["Type"];
		readonly whenBusy: WhenBusy;
	}) => Effect.Effect<Admission>;
	/**
	 * Frees the lane an execution holds and starts the next request waiting in
	 * it. Called from the execution's last activity; doing nothing when the lane
	 * has already moved on makes it safe to repeat.
	 */
	readonly release: (execution: {
		readonly key: string;
		readonly executionId: string;
	}) => Effect.Effect<void>;
	/** Repairs lanes a crash left behind. Run periodically, by one process at a time. */
	readonly reconcile: Effect.Effect<void>;
}

/**
 * What a request does when its lane is busy:
 * - `coalesce`: joins a request already waiting (which keeps its payload), or waits.
 * - `replace`: gives a request already waiting its payload, or waits.
 * - `queue`: waits behind every request already waiting.
 */
export type WhenBusy = "coalesce" | "replace" | "queue";

export type Admission = "started" | "waiting" | "coalesced" | "replaced";

export class Service extends Context.Service<Service, Interface>()("@sugabots/core/Lanes") {}

/**
 * The engine's methods take a fully typed workflow, but a lane only knows
 * workflows by name. Lane workflows' schemas must work without services, so
 * treating one as the general workflow type is safe.
 */
const general = (workflow: Workflow.Any) =>
	workflow as unknown as Workflow.Workflow<
		string,
		Workflow.AnyStructSchema,
		Schema.Top,
		Schema.Top
	>;

/**
 * Whether any lane about `subject` is running one of `workflows`, as a
 * condition for a query: "is an agent answering in this thread". A lane holds
 * waiting requests only while it runs, so a running lane covers those too.
 */
export const laneBusy = (subject: SQLWrapper, workflows: ReadonlyArray<string>) =>
	sql<boolean>`exists (
		select 1 from ${lane}
		where ${lane.subject} = (${subject})::text
			and ${lane.state} <> 'idle'
			and ${lane.workflow} in (${sql.join(
				workflows.map((name) => sql`${name}`),
				sql`, `,
			)})
	)`;

/** How long a lane may stay `starting` before `reconcile` starts its workflow again. */
const STARTING_TIMEOUT = Duration.seconds(30);
/** How long a lane may be `running` before `reconcile` asks the engine whether it has finished. */
const RUNNING_CHECK_AFTER = Duration.minutes(10);

/** Lanes for these workflows: the ones whose requests may wait, and so must be started later by name. */
export const make = (workflows: ReadonlyArray<Workflow.Any>) =>
	Effect.gen(function* () {
		const database = yield* Database;
		const engine = yield* WorkflowEngine.WorkflowEngine;
		const byName = new Map(workflows.map((workflow) => [workflow._tag, workflow]));
		const provide = Effect.provideService(Database, database);

		const workflowNamed = (name: string) => {
			const workflow = byName.get(name);
			if (!workflow) throw new Error(`No lanes are registered for workflow "${name}"`);
			return workflow;
		};

		/** Starts the lane's workflow after the enclosing transaction commits. */
		const startAfterCommit = (
			key: string,
			workflow: Workflow.Any,
			executionId: string,
			payload: unknown,
		) =>
			afterCommit(
				(
					engine.execute(general(workflow), {
						executionId,
						payload: decodePayload(workflow, payload),
						discard: true,
					}) as Effect.Effect<unknown>
				).pipe(
					Effect.andThen(
						query((db) =>
							db
								.update(lane)
								.set({ state: "running" })
								.where(
									and(
										eq(lane.key, key),
										eq(lane.executionId, executionId),
										eq(lane.state, "starting"),
									),
								),
						),
					),
					// An execution that had already finished is not run again, so it
					// will never release the lane itself.
					Effect.andThen(
						engine.poll(general(workflow), executionId) as Effect.Effect<
							Option.Option<Workflow.Result<unknown, unknown>>
						>,
					),
					Effect.flatMap((result) =>
						Option.isSome(result) && result.value._tag === "Complete"
							? Effect.suspend(() => release({ key, executionId }))
							: Effect.void,
					),
					provide,
					Effect.asVoid,
				),
			);

		/** Hands the lane to a workflow; the caller holds the lane's row lock. */
		const occupy = (key: string, workflow: Workflow.Any, payload: unknown) =>
			Effect.gen(function* () {
				const executionId = yield* workflow.executionId(decodePayload(workflow, payload));
				yield* query((db) =>
					db
						.update(lane)
						.set({ state: "starting", workflow: workflow._tag, executionId, payload })
						.where(eq(lane.key, key)),
				);
				yield* startAfterCommit(key, workflow, executionId, payload);
			});

		const admit: Interface["admit"] = ({ key, subject, workflow, payload, whenBusy }) =>
			transaction(
				Effect.gen(function* () {
					const encoded = encodePayload(workflow, payload);
					yield* query((db) =>
						db
							.insert(lane)
							.values({ key, subject })
							.onConflictDoUpdate({ target: lane.key, set: { subject: subject ?? null } }),
					);
					const [current] = yield* query((db) =>
						db.select().from(lane).where(eq(lane.key, key)).for("update"),
					);
					if (current?.state === "idle") {
						yield* occupy(key, workflow, encoded);
						return "started" as const;
					}
					const [waiting] = yield* query((db) =>
						db
							.select({ id: laneRequest.id })
							.from(laneRequest)
							.where(eq(laneRequest.laneKey, key))
							.orderBy(asc(laneRequest.createdAt), asc(laneRequest.id))
							.limit(1),
					);
					if (waiting && whenBusy === "coalesce") return "coalesced" as const;
					if (waiting && whenBusy === "replace") {
						yield* query((db) =>
							db
								.update(laneRequest)
								.set({ payload: encoded })
								.where(eq(laneRequest.id, waiting.id)),
						);
						return "replaced" as const;
					}
					yield* query((db) =>
						db
							.insert(laneRequest)
							.values({ laneKey: key, workflow: workflow._tag, payload: encoded }),
					);
					return "waiting" as const;
				}),
			).pipe(provide);

		/**
		 * The oldest request waiting in the lane. Requests for the execution
		 * that is releasing it are dropped: starting that execution again would
		 * only attach to it as it finishes, and nothing would free the lane.
		 */
		const nextRequest = (key: string, releasing: string) =>
			Effect.gen(function* () {
				while (true) {
					const [next] = yield* query((db) =>
						db
							.select()
							.from(laneRequest)
							.where(eq(laneRequest.laneKey, key))
							.orderBy(asc(laneRequest.createdAt), asc(laneRequest.id))
							.limit(1),
					);
					if (!next) return undefined;
					const workflow = workflowNamed(next.workflow);
					const executionId = yield* workflow.executionId(decodePayload(workflow, next.payload));
					if (executionId !== releasing) return next;
					yield* query((db) => db.delete(laneRequest).where(eq(laneRequest.id, next.id)));
				}
			});

		const release: Interface["release"] = ({ key, executionId }) =>
			transaction(
				Effect.gen(function* () {
					const [current] = yield* query((db) =>
						db.select().from(lane).where(eq(lane.key, key)).for("update"),
					);
					if (current?.executionId !== executionId) return;
					const next = yield* nextRequest(key, executionId);
					if (!next) {
						yield* query((db) =>
							db
								.update(lane)
								.set({ state: "idle", workflow: null, executionId: null, payload: null })
								.where(eq(lane.key, key)),
						);
						return;
					}
					yield* query((db) => db.delete(laneRequest).where(eq(laneRequest.id, next.id)));
					yield* occupy(key, workflowNamed(next.workflow), next.payload);
				}),
			).pipe(provide);

		const reconcile: Interface["reconcile"] = Effect.gen(function* () {
			const stale = yield* query((db) =>
				db
					.select()
					.from(lane)
					.where(
						and(
							eq(lane.state, "starting"),
							lt(
								lane.updatedAt,
								sql`now() - make_interval(secs => ${Duration.toSeconds(STARTING_TIMEOUT)})`,
							),
						),
					),
			);
			for (const row of stale) {
				if (!row.workflow || !row.executionId) continue;
				yield* startAfterCommit(row.key, workflowNamed(row.workflow), row.executionId, row.payload);
			}
			const long = yield* query((db) =>
				db
					.select()
					.from(lane)
					.where(
						and(
							eq(lane.state, "running"),
							lt(
								lane.updatedAt,
								sql`now() - make_interval(secs => ${Duration.toSeconds(RUNNING_CHECK_AFTER)})`,
							),
						),
					),
			);
			for (const row of long) {
				if (!row.workflow || !row.executionId) continue;
				const result = yield* engine.poll(
					general(workflowNamed(row.workflow)),
					row.executionId,
				) as Effect.Effect<Option.Option<Workflow.Result<unknown, unknown>>>;
				// Only a finished execution is released. One the engine cannot see yet
				// may still be starting, and is left to a later pass.
				if (Option.isSome(result) && result.value._tag === "Complete") {
					yield* release({ key: row.key, executionId: row.executionId });
				}
			}
		}).pipe(provide);

		return Service.of({ admit, release, reconcile });
	});

export const layer = (workflows: ReadonlyArray<Workflow.Any>) =>
	Layer.effect(Service, make(workflows));

/** Payloads are stored as their JSON encoding, so a waiting request can be decoded by name later. */
const encodePayload = (workflow: Workflow.Any, payload: unknown): unknown =>
	Schema.encodeUnknownSync(
		Schema.toCodecJson(workflow.payloadSchema) as unknown as Schema.Codec<unknown, unknown>,
	)(payload);

const decodePayload = (workflow: Workflow.Any, payload: unknown): object =>
	Schema.decodeUnknownSync(
		Schema.toCodecJson(workflow.payloadSchema) as unknown as Schema.Codec<object, unknown>,
	)(payload);

/** How often `reconcileLayer` repairs lanes. */
const RECONCILE_INTERVAL = Duration.minutes(1);

/**
 * Runs `reconcile` every minute for as long as the layer's scope is open. Every
 * process runs it; a transaction-scoped advisory lock lets one at a time do the
 * work, and a failed pass is logged and tried again next time.
 */
export const reconcileLayer = Layer.effectDiscard(
	Effect.gen(function* () {
		const lanes = yield* Service;
		const database = yield* Database;
		const pass = transaction(
			Effect.gen(function* () {
				const [lock] = yield* query((db) =>
					db.execute<{ taken: boolean }>(
						sql`select pg_try_advisory_xact_lock(hashtextextended('lanes:reconcile', 0)) as taken`,
						"objects",
					),
				);
				if (lock?.taken) yield* lanes.reconcile;
			}),
		).pipe(
			Effect.provideService(Database, database),
			Effect.catchCause((cause) => Effect.logError("Reconciling lanes failed", cause)),
		);
		yield* Effect.forkScoped(
			pass.pipe(Effect.delay(RECONCILE_INTERVAL), Effect.forever, Effect.withTracerEnabled(false)),
		);
	}),
);
