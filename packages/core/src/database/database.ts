import { PgClient } from "@effect/sql-pg";
import type { EffectDrizzleQueryError } from "drizzle-orm/effect-core";
import { type EffectPgDatabase, makeWithDefaults } from "drizzle-orm/effect-postgres";
import { Cause, Config, Context, Effect, Exit, Layer, type ManagedRuntime, Option } from "effect";
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
 * The open transaction: work waiting for the outermost one to commit, and
 * work to run just before it does.
 *
 * Code that only makes sense inside a transaction requires this service, and
 * only `transaction` provides it, so calling that code outside one does not
 * type-check.
 */
export class Transaction extends Context.Service<
	Transaction,
	{
		readonly beforeCommit: Array<Effect.Effect<void, never, Transaction>>;
		readonly afterCommit: Array<Effect.Effect<void>>;
	}
>()("Database/Transaction") {}

/**
 * Runs `work` inside the outermost transaction, after everything else in it,
 * just before the commit: for keeping something written in step with what
 * the transaction wrote. Work added while this runs, including by `work`
 * itself, runs next, in the order it was added, until none is left. A failure
 * rolls the whole transaction back.
 */
export const beforeCommit = (
	work: Effect.Effect<void, never, Database | Transaction>,
): Effect.Effect<void, never, Database | Transaction> =>
	Effect.gen(function* () {
		const open = yield* Transaction;
		const database = yield* Database;
		open.beforeCommit.push(Effect.provideService(work, Database, database));
	});

/**
 * Runs `work` once the enclosing transaction has committed, or straight away
 * when there is none. For telling the outside world what a transaction wrote:
 * a subscriber handed an event the transaction then rolls back cannot unsee
 * it. A failure in `work` is logged, not raised, because the write it
 * announces has already happened.
 */
export const afterCommit = (work: Effect.Effect<void>): Effect.Effect<void> =>
	Effect.flatMap(Effect.serviceOption(Transaction), (open) =>
		Option.isSome(open)
			? Effect.sync(() => {
					open.value.afterCommit.push(work);
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
		readonly transaction: <A, E, R>(
			use: Effect.Effect<A, E, R>,
		) => Effect.Effect<A, E, Exclude<R, Transaction>>;
	}
>()("Database") {}

/**
 * The outermost transaction is a real `begin`/`commit`. Work deferred with
 * `beforeCommit` anywhere inside runs once its body has succeeded, still
 * inside it; work deferred with `afterCommit` runs once the commit has
 * happened. Both run in the order they were deferred.
 *
 * A nested one is a savepoint, so an inner failure rolls back only the inner
 * work. Joining the outer transaction instead would mean an inner failure the
 * caller recovers from stays committed, which is not what anybody writing
 * `transaction(...)` expects. Work deferred inside the savepoint joins the
 * outer transaction's only if the savepoint succeeds; a rolled-back savepoint
 * takes its deferred work with it.
 *
 * `begin` runs its argument in a real transaction. A fake database passes
 * its argument through, keeping the rest without a connection.
 */
export function transactional(
	begin: <A, E, R>(use: Effect.Effect<A, E, R>) => Effect.Effect<A, E, R>,
) {
	return <A, E, R>(use: Effect.Effect<A, E, R>): Effect.Effect<A, E, Exclude<R, Transaction>> =>
		Effect.gen(function* () {
			const outer = yield* Effect.serviceOption(Transaction);
			const open = Transaction.of({ beforeCommit: [], afterCommit: [] });
			const body = Option.isSome(outer) ? use : Effect.tap(use, () => runBeforeCommit(open));
			const value = yield* begin(Effect.provideService(body, Transaction, open));
			if (Option.isSome(outer)) {
				outer.value.beforeCommit.push(...open.beforeCommit);
				outer.value.afterCommit.push(...open.afterCommit);
				return value;
			}
			// The commit has happened, so the announcements must too, even if the
			// fibre is being interrupted.
			yield* Effect.uninterruptible(
				Effect.forEach(open.afterCommit, loggingFailure, { discard: true }),
			);
			return value;
		});
}

const runBeforeCommit = (open: Transaction["Service"]) =>
	Effect.gen(function* () {
		for (let work = open.beforeCommit.shift(); work; work = open.beforeCommit.shift()) {
			yield* work;
		}
	});

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
		// A failure to begin or commit is a defect: no repository can do anything about it.
		transaction: transactional(
			<A, E, R>(use: Effect.Effect<A, E, R>) =>
				client.withTransaction(use).pipe(Effect.catchIf(isSqlError, Effect.die)) as Effect.Effect<
					A,
					E,
					R
				>,
		),
	});
});

export const layerNoDeps = Layer.effect(Database, make);

/** The database at `DATABASE_URL`, with its pool, which other modules also use directly. */
export const layer = layerNoDeps.pipe(Layer.provideMerge(clientLayer));

/** A query against the pool, or the open transaction. A repository's whole vocabulary. */
export const query = <A>(
	run: (executor: Executor) => Effect.Effect<A, QueryFailure>,
): Effect.Effect<A, never, Database> =>
	Effect.flatMap(Database, ({ execute }) => Effect.orDie(execute(run)));

/** Runs `use` in one transaction. Rolls back on failure and on interruption. */
export const transaction = <A, E, R>(
	use: Effect.Effect<A, E, R>,
): Effect.Effect<A, E, Exclude<R, Transaction> | Database> =>
	Effect.flatMap(Database, ({ transaction: run }) => run(use));

/**
 * The one row a write returned, for a write that always returns one: an
 * insert, or an update of a row the transaction holds. None is a defect,
 * naming `table`.
 */
export const writtenRow =
	(table: string) =>
	<Row>([row]: readonly Row[]) =>
		row === undefined
			? Effect.die(new Error(`Writing ${table} returned no row`))
			: Effect.succeed(row);

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

/**
 * Returns `operation`, which runs one method's database work on the
 * `Database` the calling service was built with, in a span named
 * `${service}.${method}`. A service whose methods go through it keeps
 * `Database` out of their types, so its callers need not provide one. Any
 * other service `work` needs, such as `CurrentActor`, stays in the method's
 * type for its caller to provide.
 */
export const serviceOperations = <Methods>(service: string) =>
	Effect.map(
		Database,
		(database) =>
			<A, E, R>(method: keyof Methods & string, work: Effect.Effect<A, E, R>) =>
				work.pipe(
					Effect.provideService(Database, database),
					Effect.withSpan(`${service}.${method}`),
				),
	);

/** Runs an Effect on a runtime that has the database, resolving with its value. */
export type RunEffect<R = Database> = <A, E>(effect: Effect.Effect<A, E, R>) => Promise<A>;

/**
 * A failure rejects with the failure value itself, not Effect's wrapper, so a
 * caller can `catch` a service's own error class. A defect rejects with the
 * thrown value.
 */
export function effectRunner<R = Database>(
	runtime: Pick<ManagedRuntime.ManagedRuntime<R, never>, "runPromiseExit">,
): RunEffect<R> {
	return async (effect) => {
		const exit = await runtime.runPromiseExit(effect);
		if (Exit.isSuccess(exit)) {
			return exit.value;
		}
		const failure = Cause.findErrorOption(exit.cause);
		throw failure._tag === "Some" ? failure.value : Cause.squash(exit.cause);
	};
}
