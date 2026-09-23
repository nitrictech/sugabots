import { drizzle, type NodePgDatabase } from "drizzle-orm/node-postgres";
import { Cause, Context, Effect, Exit, Layer, type ManagedRuntime } from "effect";
import type { Pool } from "pg";
import { statementTracing, tracedPool } from "./statement-spans.ts";

/**
 * The database, as a service.
 *
 * Two things it gives us that a shared handle does not. The pool's lifetime is
 * the layer's, so shutdown is ordered by scope exit rather than by a `stop()`
 * somebody has to remember to call. And `transaction` composes: an Effect built
 * from other Effects runs inside one Postgres transaction, and a failure, or an
 * interruption before the commit, rolls it back.
 *
 * Drizzle stays behind this service's promise boundary.
 */

/** Anything a drizzle query can run against: the pool, or a transaction. */
export type Executor = NodePgDatabase;

type Transaction = Parameters<Parameters<NodePgDatabase["transaction"]>[0]>[0];

/**
 * CurrentTransaction holds the transaction in progress, if there is one.
 *
 * Its default keeps it out of the requirements channel: a store method reads
 * the current executor without requiring an open transaction.
 */
export const CurrentTransaction = Context.Reference("Database/CurrentTransaction", {
	defaultValue: (): Transaction | undefined => undefined,
});

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
		/** Where to send a query right now: the open transaction, or the pool. */
		readonly executor: Effect.Effect<Executor>;
		/** Runs `use` in one transaction, rolling back if it fails or is interrupted. */
		readonly transaction: <A, E, R>(use: Effect.Effect<A, E, R>) => Effect.Effect<A, E, R>;
	}
>()("Database") {}

/**
 * transactionalise runs Effects through drizzle's transaction promise callback.
 * Three details preserve transaction semantics across the promise boundary.
 *
 * The caller's context is captured with `Effect.context`, so services and
 * references survive the crossing. A fresh `runPromiseExit` would start
 * with an empty context and lose them.
 *
 * The exit is carried out on a thrown value. Throwing is the only way to make
 * drizzle emit a rollback, but throwing the error itself would lose the
 * difference between a failure, a defect and an interrupt. Resuming with
 * `Effect.failCause` hands the caller the original cause intact.
 *
 * Interruption waits for the rollback. The canceler returned from
 * `Effect.callback` awaits the settled promise, so the interrupting fiber
 * does not continue until Postgres has finished.
 */
function transactionalise(root: NodePgDatabase) {
	return <A, E, R>(use: Effect.Effect<A, E, R>): Effect.Effect<A, E, R> =>
		Effect.flatMap(CurrentTransaction, (open) =>
			open === undefined ? outermost(root, use) : savepoint(open, use),
		);
}

/**
 * A real `begin`/`commit`. Work deferred with `afterCommit` anywhere inside
 * runs once the commit has happened, in the order it was deferred.
 */
function outermost<A, E, R>(root: NodePgDatabase, use: Effect.Effect<A, E, R>) {
	return Effect.gen(function* () {
		const waiting: Array<Effect.Effect<void>> = [];
		const context = yield* Effect.context<R>();
		const value = yield* within(root, Effect.provideService(use, AfterCommit, waiting), context);
		// The commit has happened, so the announcements must too, even if the
		// fibre is being interrupted.
		yield* Effect.uninterruptible(Effect.forEach(waiting, loggingFailure, { discard: true }));
		return value;
	});
}

/**
 * Nested: drizzle issues a savepoint, so an inner failure rolls back only the
 * inner work. Joining the outer transaction instead would mean an inner
 * failure the caller recovers from stays committed, which is not what anybody
 * writing `transaction(...)` expects.
 *
 * Work deferred inside the savepoint joins the outer transaction's only if the
 * savepoint succeeds; a rolled-back savepoint takes its announcements with it.
 */
function savepoint<A, E, R>(open: Transaction, use: Effect.Effect<A, E, R>) {
	return Effect.gen(function* () {
		const outer = yield* AfterCommit;
		const inner: Array<Effect.Effect<void>> = [];
		const context = yield* Effect.context<R>();
		const value = yield* within(open, Effect.provideService(use, AfterCommit, inner), context);
		if (outer) {
			outer.push(...inner);
		} else {
			yield* Effect.forEach(inner, loggingFailure, { discard: true });
		}
		return value;
	});
}

/** Runs `use` inside `executor`'s transaction — a `begin`, or a savepoint. */
function within<A, E, R>(
	executor: NodePgDatabase | Transaction,
	use: Effect.Effect<A, E, R>,
	context: Context.Context<R>,
): Effect.Effect<A, E> {
	return Effect.callback<A, E>((resume, signal) => {
		const runToExit = Effect.runPromiseExitWith(context);
		const settled = executor
			.transaction(async (transaction) => {
				const exit = await runToExit(Effect.provideService(use, CurrentTransaction, transaction), {
					signal,
				});
				if (Exit.isFailure(exit)) {
					throw new CarriedExit(exit);
				}
				return exit.value;
			})
			.then(
				(value) => resume(Effect.succeed(value)),
				(thrown) =>
					resume(
						thrown instanceof CarriedExit
							? Effect.failCause(thrown.exit.cause as Cause.Cause<E>)
							: Effect.die(thrown),
					),
			);
		return Effect.promise(() => settled);
	});
}

/**
 * Wraps an exit so it survives being thrown through drizzle's callback.
 *
 * The field is declared and assigned rather than being a constructor parameter
 * property: Node runs this source with type stripping only, and a parameter
 * property needs code generated for it. Vitest transforms fully and would not
 * have noticed.
 */
class CarriedExit {
	readonly exit: Exit.Failure<unknown, unknown>;

	constructor(exit: Exit.Failure<unknown, unknown>) {
		this.exit = exit;
	}
}

/**
 * Takes the pool rather than opening one, because better-auth needs a plain
 * handle to the same database and two pools to one Postgres is two connection
 * budgets and two shutdown paths. Closing it is still the layer's job, so it
 * happens on scope exit with everything else.
 */
export const layer = (pool: Pool): Layer.Layer<Database> =>
	Layer.effect(
		Database,
		Effect.gen(function* () {
			yield* Effect.addFinalizer(() => Effect.promise(() => pool.end()));
			const root = drizzle({ client: tracedPool(pool) });
			return {
				executor: Effect.map(CurrentTransaction, (open) => open ?? root),
				transaction: transactionalise(root),
			};
		}),
	);

/** A query against whichever executor is current. The store's whole vocabulary. */
export const query = <A>(
	run: (executor: Executor) => Promise<A>,
): Effect.Effect<A, never, Database> =>
	Effect.flatMap(Database, ({ executor }) =>
		Effect.flatMap(executor, (against) =>
			Effect.flatMap(statementTracing, (traced) =>
				Effect.promise(() => traced(() => run(against))),
			),
		),
	);

/** Runs `use` in one transaction. Rolls back on failure and on interruption. */
export const transaction = <A, E, R>(
	use: Effect.Effect<A, E, R>,
): Effect.Effect<A, E, R | Database> =>
	Effect.flatMap(Database, ({ transaction: run }) => run(use));

/**
 * A query whose rejection may be an answer rather than a fault.
 *
 * `recognise` gets the raw driver rejection and returns the domain error it
 * means, or `undefined` if it means nothing — a unique violation on the name
 * column is a conflict the caller handles; anything else is a bug and stays a
 * defect. Without this a store has to catch inside the promise and smuggle the
 * outcome back as a sentinel value, because `query` has already turned the
 * rejection into a defect that no `catchTag` can reach.
 */
export const queryCatching = <A, Failure>(
	run: (executor: Executor) => Promise<A>,
	recognise: (failure: unknown) => Failure | undefined,
): Effect.Effect<A, Failure, Database> =>
	// Wrapped in `transaction` so that inside one it becomes a savepoint.
	// Postgres aborts the whole transaction on a constraint violation, so
	// recovering from one without a savepoint leaves every later statement
	// failing with "current transaction is aborted" — the recovery would look
	// like it worked and the next write would not. Outside a transaction this
	// is one `begin`/`commit` around a single statement, which is what the
	// driver does implicitly anyway.
	transaction(
		Effect.flatMap(Database, ({ executor }) =>
			Effect.flatMap(executor, (against) =>
				Effect.flatMap(statementTracing, (traced) =>
					Effect.tryPromise({ try: () => traced(() => run(against)), catch: (cause) => cause }),
				).pipe(
					Effect.catch((cause) => {
						const meant = recognise(cause);
						return meant === undefined ? Effect.die(cause) : Effect.fail(meant);
					}),
				),
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
