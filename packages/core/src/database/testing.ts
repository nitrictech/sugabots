import { type Context, Effect, Layer, ManagedRuntime } from "effect";
import { Credentials } from "../credentials/credentials.ts";
import { Ids } from "../ids/ids.ts";
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

/**
 * What the process provides every service once, as `index.ts` does: here the
 * test database, real ids, and credentials sealed under a fixed test key.
 */
export const testInfrastructure = Layer.mergeAll(
	Ids.layer,
	Layer.succeed(Credentials.Service, Credentials.fromKey(Buffer.alloc(32).toString("base64"))),
).pipe(Layer.provideMerge(layer));

export type TestInfrastructure = Layer.Success<typeof testInfrastructure>;

export const databaseForTests = ManagedRuntime.make(testInfrastructure);

/** Closes the pool. Call from `afterAll` in any file that uses `onPostgres`. */
export const closeDatabase = (): Promise<void> => databaseForTests.dispose();

/** Runs one Effect against the test database. */
export const runOnPostgres = effectRunner<TestInfrastructure>(databaseForTests);

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
 * For the cases that are about routing, or about a fake store, and never send
 * a query. Reaching it is a bug in the test rather than a thing to tolerate, so
 * the executor dies and names itself.
 */
export const noDatabase: Layer.Layer<Database> = Layer.succeed(Database, {
	execute: () => Effect.die(new Error("This test has no database")),
	transaction: transactional((use) => use),
});
