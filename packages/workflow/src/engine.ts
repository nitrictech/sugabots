export * as WorkflowEngines from "./engine.ts";

import { NodeCrypto } from "@effect/platform-node";
import { Duration, Effect, Layer, Schedule } from "effect";
import {
	ClusterWorkflowEngine,
	RunnerHealth,
	Runners,
	Sharding,
	ShardingConfig,
	SqlMessageStorage,
	SqlRunnerStorage,
} from "effect/unstable/cluster";
import { SqlClient } from "effect/unstable/sql";
import { WorkflowEngine } from "effect/unstable/workflow";

/**
 * Effect's own workflow engines. Workflow code depends only on Effect's
 * workflow API, so which engine runs it is configuration.
 */

/** Everything in this process's memory, surviving nothing. For tests. */
export const memory: Layer.Layer<WorkflowEngine.WorkflowEngine> = WorkflowEngine.layerMemory;

/**
 * Effect's cluster engine inside this process, durable in the database behind
 * the `SqlClient` it is given (the app's). Only one process may run it, so it
 * first takes a lock that says so, and refuses to start without it.
 *
 * Its messages, signals included, are written through that `SqlClient`, so one
 * sent inside the app's transaction commits or rolls back with it. The host
 * and shard locks need one Postgres session across statements, which a
 * transaction pooler does not keep, so they go through `sessions` when given.
 */
export const singleRunnerWith = <R = never, E = never>(options: {
	/** How long to keep trying for the host lock before refusing to start. */
	readonly hostLockWait: Duration.Duration;
	/** A direct connection for the locks, when the given `SqlClient` goes through a pooler. */
	readonly sessions?: Layer.Layer<SqlClient.SqlClient, E, R>;
}) => {
	const sessions: Layer.Layer<SqlClient.SqlClient, E, R | SqlClient.SqlClient> =
		options.sessions ?? Layer.effect(SqlClient.SqlClient, SqlClient.SqlClient);
	const sharding = Sharding.layer.pipe(
		Layer.provideMerge(Runners.layerNoop),
		Layer.provideMerge(SqlMessageStorage.layer),
		Layer.provide([
			Layer.orDie(SqlRunnerStorage.layer).pipe(Layer.provide(sessions)),
			RunnerHealth.layerNoop,
		]),
		Layer.provide(ShardingConfig.layerFromEnv()),
	);
	return ClusterWorkflowEngine.layer.pipe(
		Layer.provide(sharding),
		Layer.provide(NodeCrypto.layer),
		Layer.provide(
			Layer.effectDiscard(holdHostLock(options.hostLockWait)).pipe(Layer.provide(sessions)),
		),
	);
};

/** The single runner, waiting up to 30 seconds for a predecessor to let go of the host lock. */
export const singleRunner = singleRunnerWith({ hostLockWait: Duration.seconds(30) });

/** The two keys of the host lock; the two-key form cannot collide with the cluster's own shard locks. */
const HOST_LOCK = [0x5ab0_7a1c, 1] as const;

/** How often to try for the lock while waiting. */
const HOST_LOCK_RETRY = Duration.seconds(1);

/** How often the lock is checked: a session lock vanishes silently with its connection. */
const HOST_LOCK_CHECK = Duration.seconds(5);

function holdHostLock(wait: Duration.Duration) {
	return Effect.gen(function* () {
		const sql = yield* SqlClient.SqlClient;
		const connection = yield* sql.reserve;
		// A process restarting can find its predecessor's connection not yet
		// closed, so the lock is tried for a while before giving up.
		yield* connection
			.execute("select pg_try_advisory_lock($1, $2) as held", HOST_LOCK, undefined)
			.pipe(
				Effect.flatMap(([taken]) =>
					taken?.held ? Effect.void : Effect.fail("held elsewhere" as const),
				),
				Effect.retry(Schedule.spaced(HOST_LOCK_RETRY).pipe(Schedule.upTo({ duration: wait }))),
				Effect.catchTag("SqlError", Effect.die),
				Effect.catch(() =>
					Effect.die(
						new Error(
							"Another process is already running the single-runner workflow engine. It supports one server process.",
						),
					),
				),
			);
		// Released explicitly: the connection goes back to the pool, not away.
		yield* Effect.addFinalizer(() =>
			connection
				.execute("select pg_advisory_unlock($1, $2)", HOST_LOCK, undefined)
				.pipe(Effect.ignore),
		);
		const stillHeld = connection
			.execute(
				`select 1 from pg_locks where locktype = 'advisory' and classid = $1 and objid = $2
					and pid = pg_backend_pid() and granted`,
				HOST_LOCK,
				undefined,
			)
			.pipe(Effect.map((rows) => rows.length === 1));
		// Losing the lock means another process may now run the engine beside this
		// one, so this one stops for good rather than risk running work twice.
		yield* stillHeld.pipe(
			Effect.orElseSucceed(() => false),
			Effect.flatMap((held) => (held ? Effect.void : Effect.fail("lost" as const))),
			Effect.repeat(Schedule.spaced(HOST_LOCK_CHECK)),
			Effect.catch(() =>
				Effect.sync(() => {
					console.error("Lost the single-runner workflow engine's host lock; exiting");
					process.exit(1);
				}),
			),
			Effect.forkScoped,
		);
	}).pipe(Effect.orDie);
}
