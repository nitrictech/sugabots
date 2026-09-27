import { PgClient } from "@effect/sql-pg";
import type { EffectDrizzleQueryError } from "drizzle-orm/effect-core";
import { type EffectPgDatabase, makeWithDefaults } from "drizzle-orm/effect-postgres";
import { Cause, Config, Context, Effect, Exit, Layer, type ManagedRuntime } from "effect";
import { isSqlError, type SqlError } from "effect/unstable/sql/SqlError";
import { relations } from "./relations.ts";

/**
 * The database, as a service.
 *
 * The pool's lifetime is the layer's, so shutdown is ordered by scope exit
 * rather than by a `stop()` somebody has to remember to call. And
 * `transaction` composes: an Effect built from other Effects runs inside one
 * Postgres transaction, and a failure, or an interruption before the commit,
 * rolls it back.
 *
 * There is one drizzle handle and no transaction object to pass around.
 * `@effect/sql` keeps the open transaction on the fiber, so a query made
 * through the handle inside `transaction` runs on the transaction's
 * connection, and a nested `transaction` becomes a savepoint.
 */

/** The drizzle handle every query is built on. */
export type Executor = EffectPgDatabase<typeof relations>;

/** How a query run through drizzle's effect driver can fail. */
export type QueryFailure = EffectDrizzleQueryError | SqlError;

/**
 * Work waiting for the outermost transaction to commit. `undefined` outside
 * any transaction, where there is nothing to wait for.
 */
const AfterCommit = Context.Reference("Database/AfterCommit", {
	defaultValue: (): Array<Effect.Effect<void>> | undefined => undefined,
});

/**
 * Runs `work` once the enclosing transaction has committed, or straight away
 * when there is none. For telling the outside world what a transaction wrote:
 * a subscriber handed an event the transaction then rolls back cannot unsee
 * it. A failure in `work` is logged, not raised, because the write it
 * announces has already happened.
 */
export const afterCommit = (work: Effect.Effect<void>): Effect.Effect<void> =>
	Effect.flatMap(AfterCommit, (waiting) =>
		waiting
			? Effect.sync(() => {
					waiting.push(work);
				})
			: loggingFailure(work),
	);

const loggingFailure = (work: Effect.Effect<void>): Effect.Effect<void> =>
	Effect.catchCause(work, (cause) =>
		Effect.sync(() => console.error("Work deferred to after commit failed", cause)),
	);

export class Database extends Context.Service<
	Database,
	{
		/** Runs `run` against the handle, keeping a driver failure as a failure. */
		readonly execute: <A>(
			run: (executor: Executor) => Effect.Effect<A, QueryFailure>,
		) => Effect.Effect<A, QueryFailure>;
		/** Runs `use` in one transaction, rolling back if it fails or is interrupted. */
		readonly transaction: <A, E, R>(use: Effect.Effect<A, E, R>) => Effect.Effect<A, E, R>;
	}
>()("Database") {}

/**
 * The outermost transaction is a real `begin`/`commit`; work deferred with
 * `afterCommit` anywhere inside runs once the commit has happened, in the
 * order it was deferred.
 *
 * A nested one is a savepoint, so an inner failure rolls back only the inner
 * work. Joining the outer transaction instead would mean an inner failure the
 * caller recovers from stays committed, which is not what anybody writing
 * `transaction(...)` expects. Work deferred inside the savepoint joins the
 * outer transaction's only if the savepoint succeeds; a rolled-back savepoint
 * takes its announcements with it.
 *
 * A failure to begin or commit is a defect: no store can do anything about it.
 */
function transactional(client: PgClient.PgClient) {
	return <A, E, R>(use: Effect.Effect<A, E, R>): Effect.Effect<A, E, R> =>
		Effect.gen(function* () {
			const outer = yield* AfterCommit;
			const inner: Array<Effect.Effect<void>> = [];
			const value = yield* client
				.withTransaction(Effect.provideService(use, AfterCommit, inner))
				.pipe(Effect.catchIf(isSqlError, Effect.die)) as Effect.Effect<A, E, R>;
			if (outer) {
				outer.push(...inner);
				return value;
			}
			// The commit has happened, so the announcements must too, even if the
			// fibre is being interrupted.
			yield* Effect.uninterruptible(Effect.forEach(inner, loggingFailure, { discard: true }));
			return value;
		});
}

/** The connection pool at `DATABASE_URL`, closed when the layer's scope is. */
export const clientLayer = PgClient.layerConfig({ url: Config.Redacted("DATABASE_URL") }).pipe(
	Layer.orDie,
);

/** Drizzle on whichever pool `PgClient` provides. */
export const make = Effect.gen(function* () {
	const client = yield* PgClient.PgClient;
	const root = yield* makeWithDefaults({ relations });
	return Database.of({
		execute: (run) => run(root),
		transaction: transactional(client),
	});
});

export const layerNoDeps = Layer.effect(Database, make);

/** The database at `DATABASE_URL`, with its pool, which other modules also use directly. */
export const layer = layerNoDeps.pipe(Layer.provideMerge(clientLayer));

/** A query against the pool, or the open transaction. The store's whole vocabulary. */
export const query = <A>(
	run: (executor: Executor) => Effect.Effect<A, QueryFailure>,
): Effect.Effect<A, never, Database> =>
	Effect.flatMap(Database, ({ execute }) => Effect.orDie(execute(run)));

/** Runs `use` in one transaction. Rolls back on failure and on interruption. */
export const transaction = <A, E, R>(
	use: Effect.Effect<A, E, R>,
): Effect.Effect<A, E, R | Database> =>
	Effect.flatMap(Database, ({ transaction: run }) => run(use));

/**
 * A query whose failure may be an answer rather than a fault.
 *
 * `recognise` gets the driver's failure and returns the domain error it
 * means, or `undefined` if it means nothing — a unique violation on the name
 * column is a conflict the caller handles; anything else is a bug and stays a
 * defect.
 */
export const queryCatching = <A, Failure>(
	run: (executor: Executor) => Effect.Effect<A, QueryFailure>,
	recognise: (failure: QueryFailure) => Failure | undefined,
): Effect.Effect<A, Failure, Database> =>
	// Wrapped in `transaction` so that inside one it becomes a savepoint.
	// Postgres aborts the whole transaction on a constraint violation, so
	// recovering from one without a savepoint leaves every later statement
	// failing with "current transaction is aborted" — the recovery would look
	// like it worked and the next write would not.
	transaction(
		Effect.flatMap(Database, ({ execute }) =>
			execute(run).pipe(
				Effect.catch((failure) => {
					const meant = recognise(failure);
					return meant === undefined ? Effect.die(failure) : Effect.fail(meant);
				}),
			),
		),
	);

/** Runs an Effect on a runtime that has the database, resolving with its value. */
export type RunEffect = <A, E>(effect: Effect.Effect<A, E, Database>) => Promise<A>;

/**
 * A failure rejects with the failure value itself, not Effect's wrapper, so a
 * caller can `catch` a store's own error class. A defect rejects with the
 * thrown value.
 */
export function effectRunner(
	runtime: Pick<ManagedRuntime.ManagedRuntime<Database, never>, "runPromiseExit">,
): RunEffect {
	return async (effect) => {
		const exit = await runtime.runPromiseExit(effect);
		if (Exit.isSuccess(exit)) {
			return exit.value;
		}
		const failure = Cause.findErrorOption(exit.cause);
		throw failure._tag === "Some" ? failure.value : Cause.squash(exit.cause);
	};
}
