import { type Context, Effect, Layer, ManagedRuntime } from "effect";
import { BlobStore } from "../blob-store/blob-store.ts";
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
 * A real database, for the repository and service tests.
 *
 * Such a test is about what the SQL does. `onPostgres(service)` hands back the
 * same service with its methods returning promises, so a case reads
 * `await pods.create(...)` rather than wrapping every line, and a failure
 * rejects with the service's own error so `rejects.toThrow(NameTaken)` still
 * means what it says.
 *
 * One runtime for the process, so every test file shares one pool.
 */

/**
 * What the process provides every service once, as `index.ts` does: here the
 * test database, real ids, blobs kept in the database, and credentials sealed
 * under a fixed test key.
 */
export const testInfrastructure = Layer.mergeAll(
	BlobStore.layer,
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
