import { Effect, Layer, ManagedRuntime } from "effect";
import {
	Database,
	type Executor,
	effectRunner,
	layer,
	type QueryFailure,
	query,
	type RunEffect,
	transactional,
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

export const databaseForTests = ManagedRuntime.make(layer);

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

/**
 * `store` with its methods returning promises, each run by `run`. A method
 * needing a service `run` does not provide is a type error.
 */
export function promising<R>(run: RunEffect<R>) {
	return <
		Store extends Record<keyof Store, (...args: never[]) => Effect.Effect<unknown, unknown, R>>,
	>(
		store: Store,
	): Promised<Store> => {
		const promises: Record<string, unknown> = {};
		for (const [name, method] of Object.entries(store)) {
			const call = method as (...args: unknown[]) => Effect.Effect<unknown, unknown, R>;
			promises[name] = (...args: unknown[]) => run(call.call(store, ...args));
		}
		return promises as Promised<Store>;
	};
}

export const onPostgres = promising(runOnPostgres);

/**
 * A database nothing is expected to reach.
 *
 * For the cases that are about routing, or about a fake store, and never send
 * a query. Reaching it is a bug in the test rather than a thing to tolerate, so
 * the executor dies and names itself.
 */
export const noDatabase: Layer.Layer<Database> = Layer.succeed(Database, {
	execute: () => Effect.die(new Error("This test has no database")),
	transaction: transactional((use) => use),
});
