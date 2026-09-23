import { Effect, Layer, ManagedRuntime } from "effect";
import {
	Database,
	type Executor,
	effectRunner,
	layer,
	type QueryFailure,
	query,
} from "./database.ts";

/**
 * A real database, for the store tests.
 *
 * A store test is about what the SQL does. `onPostgres(store)` hands back the
 * same store with its methods returning promises, so a case reads
 * `await store.create(...)` rather than wrapping every line, and a failure
 * rejects with the store's own error so `rejects.toThrow(NameTaken)` still
 * means what it says.
 *
 * One runtime for the process, so every test file shares one pool.
 */

const url = process.env.DATABASE_URL;

if (!url) {
	throw new Error("DATABASE_URL is required. Copy .env.example to .env.");
}

export const databaseForTests = ManagedRuntime.make(layer(url));

/** Closes the pool. Call from `afterAll` in any file that uses `onPostgres`. */
export const closeDatabase = (): Promise<void> => databaseForTests.dispose();

/** Runs one Effect against the test database. */
export const runOnPostgres = effectRunner(databaseForTests);

/** Runs one query against the test database, for a case's fixtures and checks. */
export const onDatabase = <A>(run: (db: Executor) => Effect.Effect<A, QueryFailure>): Promise<A> =>
	runOnPostgres(query(run));

/** The same store with its methods returning promises. */
export type Promised<Store> = {
	[Method in keyof Store]: Store[Method] extends (
		...args: infer Args
	) => Effect.Effect<infer Value, infer _Failure, infer _Context>
		? (...args: Args) => Promise<Value>
		: never;
};

export function onPostgres<Store extends object>(store: Store): Promised<Store> {
	const promises: Record<string, unknown> = {};
	for (const [name, method] of Object.entries(store)) {
		const call = method as (...args: unknown[]) => Effect.Effect<unknown, unknown, Database>;
		promises[name] = (...args: unknown[]) => runOnPostgres(call.call(store, ...args));
	}
	return promises as Promised<Store>;
}

/**
 * A database nothing is expected to reach.
 *
 * For the cases that are about routing, or about a fake store, and never send
 * a query. Reaching it is a bug in the test rather than a thing to tolerate, so
 * the executor dies and names itself.
 */
export const noDatabase: Layer.Layer<Database> = Layer.succeed(Database, {
	execute: () => Effect.die(new Error("This test has no database")),
	transaction: (use) => use,
});
