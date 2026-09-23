import { AsyncLocalStorage } from "node:async_hooks";
import { type Clock, Effect, Exit, Option, Tracer } from "effect";
import type { Pool, PoolClient } from "pg";

/**
 * One span per SQL statement, so a trace shows every round trip a store
 * method makes and how long each took.
 *
 * A span per `query` call would not be enough: one call may run many
 * statements, as a loader that loops over rows does. So the timing happens at
 * the driver, where each statement is sent, and the span's parent is whichever
 * Effect span was current when `query` was called. The two meet through
 * `AsyncLocalStorage`, because drizzle's promises sit between them.
 *
 * Only drizzle's calls are traced: those come through `tracedPool` in the
 * promise form. The callback form is what `pg-pool` uses internally, and
 * tracing it too would count each statement twice.
 */

interface StatementStart {
	readonly sql: string;
	/** Callers queued for a connection when the statement was issued. Above zero, the pool is exhausted. */
	readonly waitingForConnection: number;
}

/** Ends a statement's span, failed if `failure` is given. */
type EndStatement = (failure?: unknown) => void;
type StartStatement = (statement: StatementStart) => EndStatement;

const currentStatementTracer = new AsyncLocalStorage<StartStatement>();

const statementTracer: Effect.Effect<StartStatement | undefined> = Effect.gen(function* () {
	const parent = yield* Effect.option(Effect.currentSpan);
	if (Option.isNone(parent)) return undefined;
	const tracer = yield* Tracer.Tracer;
	const clock = yield* Effect.clockWith(Effect.succeed<Clock.Clock>);
	return ({ sql, waitingForConnection }) => {
		const operation = sql.trimStart().split(/\s/, 1)[0]?.toUpperCase() ?? "QUERY";
		const span = tracer.span({
			name: operation,
			parent,
			annotations: parent.value.annotations,
			links: [],
			startTime: clock.currentTimeNanosUnsafe(),
			kind: "client",
			root: false,
			sampled: parent.value.sampled,
		});
		span.attribute("db.system.name", "postgresql");
		span.attribute("db.operation.name", operation);
		span.attribute("db.query.text", sql);
		span.attribute("db.client.connection.waiting", waitingForConnection);
		return (failure) =>
			span.end(
				clock.currentTimeNanosUnsafe(),
				failure === undefined ? Exit.void : Exit.die(failure),
			);
	};
});

/** Runs a promise-returning query, tracing each statement it sends. */
export type TraceStatements = <A>(run: () => Promise<A>) => Promise<A>;

/**
 * A `TraceStatements` whose spans are children of the current span. With no
 * current span nothing is traced: a background loop's polling would otherwise
 * start a trace per statement.
 */
export const statementTracing: Effect.Effect<TraceStatements> = Effect.map(
	statementTracer,
	(start) =>
		start === undefined
			? (run) => run()
			: // Awaited inside, because drizzle's queries are lazy thenables: they
				// send nothing until `then` is called, and that call must happen
				// inside the storage's scope.
				(run) => currentStatementTracer.run(start, async () => await run()),
);

/**
 * `pool`, with the statements drizzle sends through it and through the
 * clients it hands out traced. The pool itself is untouched, so its other
 * users (better-auth, the event relay) are not.
 */
export function tracedPool(pool: Pool): Pool {
	return new Proxy(pool, {
		get(target, key) {
			if (key === "query") return tracedQuery(target, target.query.bind(target));
			if (key === "connect") return tracedConnect(target);
			return bound(target, key);
		},
	});
}

function tracedConnect(pool: Pool): Pool["connect"] {
	return ((callback?: Parameters<Pool["connect"]>[0]) =>
		callback
			? pool.connect(callback)
			: pool.connect().then((client) => tracedClient(pool, client))) as Pool["connect"];
}

function tracedClient(pool: Pool, client: PoolClient): PoolClient {
	return new Proxy(client, {
		get(target, key) {
			if (key === "query") return tracedQuery(pool, target.query.bind(target));
			return bound(target, key);
		},
	});
}

/** Methods are bound to the real object, so `pg`'s internals never see a proxy as `this`. */
function bound<T extends object>(target: T, key: string | symbol): unknown {
	const value: unknown = Reflect.get(target, key);
	return typeof value === "function" ? value.bind(target) : value;
}

type Query = (...args: unknown[]) => unknown;

function tracedQuery<Q>(pool: Pool, query: Q): Q {
	const send = query as Query;
	return ((...args: unknown[]) => {
		const start = currentStatementTracer.getStore();
		if (start === undefined || typeof args.at(-1) === "function") return send(...args);
		const end = start({ sql: statementText(args[0]), waitingForConnection: pool.waitingCount });
		const result = send(...args);
		if (result instanceof Promise) {
			result.then(
				() => end(),
				(failure: unknown) => end(failure),
			);
		} else {
			end();
		}
		return result;
	}) as Q;
}

function statementText(first: unknown): string {
	if (typeof first === "string") return first;
	if (typeof first === "object" && first !== null && "text" in first) return String(first.text);
	return "";
}
