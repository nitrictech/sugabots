import { setTimeout as delay } from "node:timers/promises";
import { sql } from "drizzle-orm";
import { type Context, Effect, Layer, ManagedRuntime } from "effect";
import { onTestFinished } from "vitest";
import { BlobStore } from "../blob-store/blob-store.ts";
import { Ids } from "../ids/ids.ts";
import { Secrets } from "../secrets/secrets.ts";
import { ServerSettings } from "../server-settings/server-settings.ts";
import {
	Database,
	type Executor,
	effectRunner,
	layer,
	type QueryFailure,
	query,
	type RunEffect,
	type Transaction,
	transaction,
	transactional,
} from "./database.ts";

/**
 * A real database, for the store and service tests.
 *
 * Such a test is about what the SQL does. `onPostgres(service)` hands back the
 * same service with its methods returning promises, so a case reads
 * `await projects.create(...)` rather than wrapping every line, and a failure
 * rejects with the service's own error so `rejects.toThrow(NameTaken)` still
 * means what it says.
 *
 * One runtime per test file: its cases share the runtime's pool, and the file
 * disposes of it in its `afterAll` with `closeDatabase`.
 */

/**
 * What the process provides every service once, as `index.ts` does: here the
 * test database, real ids, blobs kept in the database, and secrets encrypted
 * under a fixed test key.
 */
export const testInfrastructure = Layer.mergeAll(
	BlobStore.layer,
	Layer.succeed(Secrets.Service, Secrets.fromKey(Buffer.alloc(32).toString("base64"))),
	Layer.succeed(
		ServerSettings.Service,
		ServerSettings.fromUrls({ isProduction: false, publicUrl: "http://sugabots.test" }),
	),
).pipe(Layer.provideMerge(Ids.layer), Layer.provideMerge(layer));

export type TestInfrastructure = Layer.Success<typeof testInfrastructure>;

export const databaseForTests = ManagedRuntime.make(testInfrastructure);

/** Closes the pool. Call from `afterAll` in any file that uses `onPostgres`. */
export const closeDatabase = (): Promise<void> => databaseForTests.dispose();

/** Runs one Effect against the test database. */
export const runOnPostgres = effectRunner<TestInfrastructure>(databaseForTests);

/** Runs one query against the test database, for a case's fixtures and checks. */
export const onDatabase = <A>(run: (db: Executor) => Effect.Effect<A, QueryFailure>): Promise<A> =>
	runOnPostgres(query(run));

const LOCK_WAIT_POLL_INTERVAL_MS = 20;

/**
 * Waits until `count` connections to this worker's database are waiting on locks.
 * Use a held transaction's `waitForWaiters` to limit the observation to its locks.
 */
export function waitUntilWaitingOnLocks(count: number, signal?: AbortSignal): Promise<void> {
	return observeLockWait(count, signal);
}

function observeLockWait(count: number, signal?: AbortSignal, blockerPid?: number): Promise<void> {
	const finished = new AbortController();
	const stop = signal ? AbortSignal.any([finished.signal, signal]) : finished.signal;
	const waiting = pollLockWait(count, stop, blockerPid);
	onTestFinished(async () => {
		finished.abort();
		await waiting.catch(() => {});
	});
	return waiting;
}

async function pollLockWait(count: number, signal: AbortSignal, blockerPid: number | undefined) {
	while (true) {
		signal.throwIfAborted();
		const [waiting] = await runOnPostgres(
			query((db) =>
				db.execute<{ count: number }>(
					blockerPid === undefined
						? sql`select count(*)::int as count from pg_stat_activity
						where datname = current_database() and wait_event_type = 'Lock'`
						: sql`with recursive blocked(pid) as (
						select ${blockerPid}::int
						union
						select activity.pid from pg_stat_activity as activity
						join blocked on blocked.pid = any(pg_blocking_pids(activity.pid))
						where activity.datname = current_database() and activity.wait_event_type = 'Lock'
					)
					select count(*)::int as count from blocked where pid <> ${blockerPid}`,
					"objects",
				),
			),
			{ signal },
		);
		if ((waiting?.count ?? 0) >= count) return;
		await delay(LOCK_WAIT_POLL_INTERVAL_MS, undefined, { signal });
	}
}

/**
 * Runs `work` in a transaction and holds it open, with the locks `work` took,
 * until `release` is called, so a case can start another write against them.
 * `afterRelease` runs in the same transaction once released, before it commits.
 *
 * `held` resolves with `work`'s value once `work` is done, or rejects if the
 * transaction fails first. `release` lets the transaction finish and resolves
 * once it has committed. Call it to choose when the transaction commits; a case
 * that ends without calling it, by failing or timing out, has the transaction
 * released when it finishes, so its locks never stall the cases after it.
 *
 * Call it from inside a case, not from a `beforeAll` or `beforeEach`.
 */
export function holdTransaction<A>(
	work: Effect.Effect<A, unknown, TestInfrastructure | Transaction>,
	afterRelease: Effect.Effect<unknown, unknown, TestInfrastructure | Transaction> = Effect.void,
): {
	held: Promise<A>;
	release: () => Promise<void>;
	waitForWaiters: (count: number, signal?: AbortSignal) => Promise<void>;
} {
	const released = Promise.withResolvers<void>();
	const acquired = Promise.withResolvers<{ value: A; pid: number }>();
	const held = acquired.promise.then(({ value }) => value);
	const finished = runOnPostgres(
		transaction(
			Effect.gen(function* () {
				const [backend] = yield* query((db) =>
					db.execute<{ pid: number }>(sql`select pg_backend_pid() as pid`, "objects"),
				);
				if (!backend) return yield* Effect.die("Postgres returned no backend pid");
				const value = yield* work;
				acquired.resolve({ value, pid: backend.pid });
				yield* Effect.promise(() => released.promise);
				yield* afterRelease;
			}),
		),
	).then(() => {});
	void finished.catch(acquired.reject);
	const release = () => {
		released.resolve();
		return finished;
	};
	// A failure has already reached the case through `held` or `release`.
	onTestFinished(() => release().catch(() => {}));
	return {
		held,
		release,
		waitForWaiters: async (count, signal) => {
			const { pid } = await acquired.promise;
			return observeLockWait(count, signal, pid);
		},
	};
}

/** The same service with its methods returning promises. */
export type Promised<Service> = {
	[Method in keyof Service]: Service[Method] extends (
		...args: infer Args
	) => Effect.Effect<infer Value, infer _Failure, infer _Context>
		? (...args: Args) => Promise<Value>
		: never;
};

/**
 * `service` with its methods returning promises, each run by `run`. A method
 * needing a service `run` does not provide is a type error.
 */
export function promising<R>(run: RunEffect<R>) {
	return <
		Service extends Record<keyof Service, (...args: never[]) => Effect.Effect<unknown, unknown, R>>,
	>(
		service: Service,
	): Promised<Service> => {
		const promises: Record<string, unknown> = {};
		for (const [name, method] of Object.entries(service)) {
			const call = method as (...args: unknown[]) => Effect.Effect<unknown, unknown, R>;
			promises[name] = (...args: unknown[]) => run(call.call(service, ...args));
		}
		return promises as Promised<Service>;
	};
}

export const onPostgres = promising(runOnPostgres);

/**
 * `service`, built by `layer` over the test infrastructure, with its methods
 * returning promises. Call it from `beforeAll`, so a file whose cases skip
 * without a database never connects.
 */
export async function servedOnPostgres<
	Identifier,
	Shape extends Record<keyof Shape, (...args: never[]) => Effect.Effect<unknown, unknown>>,
>(
	service: Context.Key<Identifier, Shape>,
	layer: Layer.Layer<Identifier, never, TestInfrastructure>,
): Promise<Promised<Shape>> {
	return onPostgres(await runOnPostgres(Effect.provide(service, layer)));
}

/**
 * A database nothing is expected to reach.
 *
 * For the cases that are about routing, or about a fake service, and never send
 * a query. Reaching it is a bug in the test rather than a thing to tolerate, so
 * the executor dies and names itself.
 */
export const noDatabase: Layer.Layer<Database> = Layer.succeed(Database, {
	execute: () => Effect.die(new Error("This test has no database")),
	transaction: transactional((use) => use),
});
