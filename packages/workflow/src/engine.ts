export * as WorkflowEngines from "./engine.ts";

import { NodeCrypto } from "@effect/platform-node";
import { Duration, Effect, Layer, Schedule } from "effect";
import { ClusterWorkflowEngine, SingleRunner } from "effect/unstable/cluster";
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
 */
export const singleRunner = ClusterWorkflowEngine.layer.pipe(
	Layer.provide(SingleRunner.layer({ runnerStorage: "sql" })),
	Layer.provide(NodeCrypto.layer),
	Layer.provide(Layer.effectDiscard(holdHostLock())),
);

/** The two keys of the host lock; the two-key form cannot collide with the cluster's own shard locks. */
const HOST_LOCK = [0x5ab0_7a1c, 1] as const;

/** How often the lock is checked: a session lock vanishes silently with its connection. */
const HOST_LOCK_CHECK = Duration.seconds(5);

function holdHostLock() {
	return Effect.gen(function* () {
		const sql = yield* SqlClient.SqlClient;
		const connection = yield* sql.reserve;
		const [taken] = yield* connection.execute(
			"select pg_try_advisory_lock($1, $2) as held",
			HOST_LOCK,
			undefined,
		);
		if (!taken?.held) {
			return yield* Effect.die(
				new Error(
					"Another process is already running the single-runner workflow engine. It supports one server process.",
				),
			);
		}
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
