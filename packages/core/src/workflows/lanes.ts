export * as Lanes from "./lanes.ts";

import type { Activities } from "@sugabots/workflow/activities";
import { and, asc, eq, lt, type SQL, type SQLWrapper, sql } from "drizzle-orm";
import { Context, Duration, Effect, Exit, Layer, Option, Schema } from "effect";
import { Activity, DurableDeferred, type Workflow, WorkflowEngine } from "effect/unstable/workflow";
import { afterCommit, Database, query, transaction } from "../database/database.ts";
import { processLayer, Tier } from "../tiers.ts";
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
	readonly admit: <W extends Workflow.Any>(
		request: {
			readonly key: string;
			/** What the lane's work is about (a chat, say), for `laneBusy`. */
			readonly subject?: string;
			readonly workflow: W;
			readonly payload: W["payloadSchema"]["Type"];
			/**
			 * For `coalesce`: whether this request may join the waiting request
			 * whose payload is `waiting`. Any, when unset.
			 */
			readonly joins?: (waiting: W["payloadSchema"]["Type"]) => boolean;
		} & (WaitingPolicy | ResumePolicy),
	) => Effect.Effect<Admission>;
	/**
	 * Hands the lane to the oldest queued request, starting a new workflow or
	 * waking the execution waiting to resume. Safe to repeat after the lane
	 * has moved on. An execution that doesn't hold the lane gives up the
	 * requests it has waiting there instead, as it is ending.
	 */
	readonly release: (execution: {
		readonly key: string;
		readonly executionId: string;
	}) => Effect.Effect<void>;
	/**
	 * Drops the requests waiting in lanes about any of `subjects` for
	 * `workflows`, so they never start. What is already running is left alone,
	 * and so is a request another transaction holds.
	 */
	readonly dropWaiting: (
		subjects: ReadonlyArray<string>,
		workflows: ReadonlyArray<string>,
	) => Effect.Effect<void>;
	/** Repairs lanes a crash left behind. Run periodically, by one process at a time. */
	readonly reconcile: Effect.Effect<void>;
}

/**
 * What a request does when its lane is busy:
 * - `coalesce`: joins the oldest request already waiting that it `joins`
 *   (which keeps its payload), or waits.
 * - `replace`: gives a request already waiting its payload, or waits.
 * - `queue`: waits behind every request already waiting.
 */
export type WhenBusy = "coalesce" | "replace" | "queue";

type WaitingPolicy = { readonly whenBusy: WhenBusy; readonly resumeRound?: never };

/** Queues a suspended execution once, or reports that it holds the lane. */
type ResumePolicy = { readonly whenBusy: "resume"; readonly resumeRound: string };

/** The signal a queued execution waits for after its approvals were decided. */
export const laneGranted = (round: string) => DurableDeferred.make(`laneGranted/${round}`);

/** What became of a request: its workflow started, it waits, or it joined or replaced one waiting. */
export type Admission = "started" | "waiting" | "coalesced" | "replaced";

export class Service extends Context.Service<Service, Interface>()("@sugabots/core/Lanes") {
	declare readonly [Tier]: "process";
}

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
 * condition for a query: "is a bot answering in this chat". A lane holds
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

/**
 * When the request that has waited longest in a lane about `subject` running
 * `workflow` was made, as an ISO timestamp to the millisecond, for a query;
 * null when none waits.
 */
export const waitingSince = (subject: SQLWrapper, workflow: string) =>
	sql<string | null>`(
		select to_char(min(waiting.created_at) at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"')
		from ${laneRequest} waiting
		join ${lane} on ${lane.key} = waiting.lane_key
		where ${lane.subject} = (${subject})::text and ${lane.workflow} = ${workflow}
	)`;

/**
 * Whether a lane about `subject` holds a request for `workflow` whose payload
 * `matches`, starting, running or waiting to start, as a condition for a
 * query. `matches` is given the payload as its JSON encoding.
 */
export const holdsRequest = (
	subject: SQLWrapper,
	workflow: string,
	matches: (payload: SQLWrapper) => SQL | undefined,
) =>
	sql<boolean>`(exists (
		select 1 from ${lane}
		where ${lane.subject} = (${subject})::text
			and ${lane.workflow} = ${workflow}
			and ${lane.state} <> 'idle'
			and ${matches(lane.payload) ?? sql`true`}
	) or exists (
		select 1 from ${laneRequest} waiting
		join ${lane} on ${lane.key} = waiting.lane_key
		where ${lane.subject} = (${subject})::text
			and waiting.workflow = ${workflow}
			and ${matches(sql`waiting.payload`) ?? sql`true`}
	))`;

/** The statement behind `Interface.dropWaiting`. */
const dropWaitingStatement = (subjects: ReadonlyArray<string>, workflows: ReadonlyArray<string>) =>
	sql`delete from ${laneRequest}
		where ${laneRequest.id} in (
			select waiting.id from ${laneRequest} waiting
			join ${lane} on ${lane.key} = waiting.lane_key
			where ${lane.subject} in (${sql.join(
				subjects.map((subject) => sql`${subject}`),
				sql`, `,
			)})
				and ${lane.workflow} in (${sql.join(
					workflows.map((name) => sql`${name}`),
					sql`, `,
				)})
			for update of waiting skip locked
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

		// A queued execution may have been interrupted before it got the lane.
		const releaseIfFinished = (key: string, workflow: Workflow.Any, executionId: string) =>
			Effect.flatMap(
				engine.poll(general(workflow), executionId) as Effect.Effect<
					Option.Option<Workflow.Result<unknown, unknown>>
				>,
				(result) =>
					Option.isSome(result) && result.value._tag === "Complete"
						? Effect.suspend(() => release({ key, executionId }))
						: Effect.void,
			);

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
					Effect.andThen(releaseIfFinished(key, workflow, executionId)),
					provide,
					Effect.asVoid,
				),
			);

		/** Hands the lane to a workflow; the caller holds the lane's row lock. */
		const occupy = (
			key: string,
			workflow: Workflow.Any,
			payload: unknown,
			alreadyExecuting = false,
		) =>
			Effect.gen(function* () {
				const executionId = yield* workflow.executionId(decodePayload(workflow, payload));
				const round = approvalResumeRound(payload);
				const state = alreadyExecuting || typeof round === "string" ? "running" : "starting";
				yield* query((db) =>
					db
						.update(lane)
						.set({ state, workflow: workflow._tag, executionId, payload })
						.where(eq(lane.key, key)),
				);
				if (alreadyExecuting) return;
				if (typeof round !== "string") {
					yield* startAfterCommit(key, workflow, executionId, payload);
					return;
				}
				// The durable grant and the handoff commit together. A replay can
				// read the grant even if the turn wasn't yet waiting for it.
				const granted = laneGranted(round);
				const grant = DurableDeferred.succeed(granted, {
					token: DurableDeferred.tokenFromExecutionId(granted, {
						workflow: general(workflow),
						executionId,
					}),
					value: undefined,
				}).pipe(Effect.provideService(WorkflowEngine.WorkflowEngine, engine));
				yield* grant;
				// The engine looks for the grant as it is written, before this
				// transaction commits, and missing it there, waits for its next
				// poll, seconds later. Sent again once committed, the grant wakes
				// the execution at once; the first sent stands.
				yield* afterCommit(
					grant.pipe(Effect.andThen(releaseIfFinished(key, workflow, executionId))),
				);
			});

		const admit: Interface["admit"] = ({
			key,
			subject,
			workflow,
			payload,
			whenBusy,
			resumeRound,
			joins,
		}) =>
			transaction(
				Effect.gen(function* () {
					const encoded = encodePayload(workflow, payload);
					const retained =
						whenBusy === "resume" ? { ...encoded, resumeAfterApproval: resumeRound } : encoded;
					yield* query((db) =>
						db
							.insert(lane)
							.values({ key, subject })
							.onConflictDoUpdate({ target: lane.key, set: { subject: subject ?? null } }),
					);
					const [current] = yield* query((db) =>
						db.select().from(lane).where(eq(lane.key, key)).for("update"),
					);
					const resuming = whenBusy === "resume" ? yield* workflow.executionId(payload) : undefined;
					if (resuming && current?.executionId === resuming) return "started" as const;
					if (current?.state === "idle") {
						yield* occupy(key, workflow, encoded, whenBusy === "resume");
						return "started" as const;
					}
					const allWaiting = yield* query((db) =>
						db
							.select({
								id: laneRequest.id,
								payload: laneRequest.payload,
								workflow: laneRequest.workflow,
							})
							.from(laneRequest)
							.where(eq(laneRequest.laneKey, key))
							.orderBy(asc(laneRequest.createdAt), asc(laneRequest.id)),
					);
					if (resuming) {
						for (const candidate of allWaiting) {
							if (candidate.workflow !== workflow._tag) continue;
							const queued = decodePayload(workflow, candidate.payload) as typeof payload;
							if ((yield* workflow.executionId(queued)) !== resuming) continue;
							if (resumeRound && approvalResumeRound(candidate.payload) !== resumeRound) {
								yield* query((db) =>
									db
										.update(laneRequest)
										.set({ payload: retained })
										.where(eq(laneRequest.id, candidate.id)),
								);
							}
							return "waiting" as const;
						}
					}
					const waiting = allWaiting.find((candidate) => !approvalResumeRound(candidate.payload));
					if (
						whenBusy === "coalesce" &&
						allWaiting.some(
							(candidate) =>
								!approvalResumeRound(candidate.payload) &&
								(!joins || joins(decodePayload(workflow, candidate.payload) as typeof payload)),
						)
					) {
						return "coalesced" as const;
					}
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
							.values({ laneKey: key, workflow: workflow._tag, payload: retained }),
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

		/**
		 * Drops the requests waiting in the lane for the execution
		 * `executionId`; the caller holds the lane's row lock.
		 */
		const dropRequestsOf = (key: string, executionId: string) =>
			Effect.gen(function* () {
				const waiting = yield* query((db) =>
					db
						.select({
							id: laneRequest.id,
							workflow: laneRequest.workflow,
							payload: laneRequest.payload,
						})
						.from(laneRequest)
						.where(eq(laneRequest.laneKey, key)),
				);
				for (const request of waiting) {
					const workflow = workflowNamed(request.workflow);
					const queued = yield* workflow.executionId(decodePayload(workflow, request.payload));
					if (queued !== executionId) continue;
					yield* query((db) => db.delete(laneRequest).where(eq(laneRequest.id, request.id)));
				}
			});

		const release: Interface["release"] = ({ key, executionId }) =>
			transaction(
				Effect.gen(function* () {
					const [current] = yield* query((db) =>
						db.select().from(lane).where(eq(lane.key, key)).for("update"),
					);
					// An execution releasing a lane it doesn't hold is ending, as one
					// interrupted while queued to resume is: it gives up its place, so
					// the lane is never handed to it once it has finished.
					if (current?.executionId !== executionId) {
						yield* dropRequestsOf(key, executionId);
						return;
					}
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

		const dropWaiting: Interface["dropWaiting"] = (subjects, workflows) =>
			subjects.length === 0
				? Effect.void
				: query((db) => db.execute(dropWaitingStatement(subjects, workflows))).pipe(
						Effect.asVoid,
						provide,
					);

		return Service.of({ admit, release, dropWaiting, reconcile });
	});

/** Lanes for `workflows`, as {@link make} builds them. */
export const layerFor = (workflows: ReadonlyArray<Workflow.Any>) =>
	processLayer(Layer.effect(Service, make(workflows)));

/**
 * `definition`'s implementation, run in the lane `lane(payload)`. However the
 * body ends, the execution then releases the lane, as an activity of its own,
 * and the next request waiting in it starts.
 *
 * - A body that fails is logged, and `onFailure` runs before the lane is
 *   released, so the failure is recorded before newer work runs in the lane.
 * - `onReleased` runs once the lane is free, for what cannot happen while the
 *   execution holds it.
 * - A suspended body is not over: its execution keeps the lane until it
 *   resumes and ends.
 *
 * `onFailure` and `onReleased` name activities of `activities`, so `resolve`
 * can rebuild every activity the workflow runs, the lane's release included,
 * from its full name and the payload.
 */
export const workflow = <
	Name extends string,
	Payload extends Workflow.AnyStructSchema,
	R,
	Id,
	Shape,
	Definitions,
	Failure extends Activities.RecordingName<Shape, Definitions> = never,
	Released extends Activities.RecordingName<Shape, Definitions> = never,
>(
	definition: Workflow.Workflow<Name, Payload, typeof Schema.Void, typeof Schema.Never>,
	options: {
		readonly lane: (payload: Payload["Type"]) => string;
		readonly activities: Activities.Set<Payload["Type"], Id, Shape, Definitions>;
		readonly body: (payload: Payload["Type"]) => Effect.Effect<void, unknown, R>;
		/** The activity that records the body's failure. */
		readonly onFailure?: Failure;
		/** The activity to run once the lane is free. */
		readonly onReleased?: Released;
	},
) => {
	// `RecordingName` limits `name` to activities without an input that return
	// nothing and cannot fail, which is what this signature says.
	const ending = options.activities.activity as unknown as (
		name: Failure | Released,
		payload: Payload["Type"],
	) => Activity.Activity<
		typeof Schema.Void,
		typeof Schema.Never,
		Id | Activities.ServicesOf<Shape[Failure | Released]>
	>;
	const releaseLane = (payload: Payload["Type"]) =>
		Activity.make({
			name: RELEASE_LANE,
			execute: Effect.gen(function* () {
				const lanes = yield* Service;
				const executionId = yield* definition.executionId(payload);
				yield* lanes.release({ key: options.lane(payload), executionId });
			}),
		});
	return {
		definition,
		layer: definition.toLayer((payload) =>
			Effect.gen(function* () {
				const ended = yield* Effect.exit(options.body(payload));
				// A suspension interrupts the body, and the engine records the
				// execution as suspended only if it ends interrupted.
				const instance = yield* WorkflowEngine.WorkflowInstance;
				if (instance.suspended) return yield* Effect.interrupt;
				if (Exit.isFailure(ended)) {
					yield* Effect.logError(`The ${definition._tag} workflow failed`, ended.cause);
					if (options.onFailure) yield* ending(options.onFailure, payload);
				}
				yield* releaseLane(payload);
				if (options.onReleased) yield* ending(options.onReleased, payload);
			}),
		),
		/** The activity of this workflow with this full name, rebuilt from the payload; `undefined` if none. */
		resolve: (
			fullName: string,
			payload: Payload["Type"],
		): Activity.Activity<Schema.Constraint, Schema.Constraint, unknown> | undefined =>
			fullName === RELEASE_LANE
				? // A specific activity is one of the general type; the schemas only narrow it.
					(releaseLane(payload) as never)
				: options.activities.resolve(fullName, payload),
	};
};

/** The name of the activity that releases a lane workflow's lane. */
const RELEASE_LANE = "releaseLane";

/** Older queued approvals have a boolean marker and are still resumed by their journaled timer. */
const approvalResumeRound = (payload: unknown) =>
	typeof payload === "object" && payload !== null && "resumeAfterApproval" in payload
		? payload.resumeAfterApproval
		: undefined;

const encodePayload = (workflow: Workflow.Any, payload: unknown): object =>
	Schema.encodeUnknownSync(
		Schema.toCodecJson(workflow.payloadSchema) as unknown as Schema.Codec<unknown, object>,
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
).pipe(processLayer);
