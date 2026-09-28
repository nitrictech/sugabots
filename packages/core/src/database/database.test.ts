import { sql } from "drizzle-orm";
import { Cause, Context, Data, Deferred, Effect, Exit, Fiber, ManagedRuntime } from "effect";
import { afterAll, beforeAll, expect, it } from "vitest";
import {
	afterCommit,
	batchedBeforeCommit,
	beforeCommit,
	type Database,
	effectRunner,
	layer,
	query,
	queryCatching,
	transaction,
} from "./database.ts";
import { isUniqueViolation } from "./errors.ts";

/**
 * What `transaction` has to guarantee, against a real Postgres: the
 * transaction ends the way the Effect did, nested ones are savepoints, and
 * deferred work waits for the commit. None of that is visible from the types,
 * so it is checked.
 */

const database = layer;
const table = `database_test_${Date.now().toString(36)}`;

/** One runtime, so every case shares one pool and the layer is built once. */
const runtime = ManagedRuntime.make(database);
const run = <A, E>(effect: Effect.Effect<A, E, Database>) => runtime.runPromiseExit(effect);

beforeAll(async () => {
	await run(query((db) => db.execute(sql.raw(`create table "${table}" (n int primary key)`))));
});

afterAll(async () => {
	await run(query((db) => db.execute(sql.raw(`drop table if exists "${table}"`))));
	await runtime.dispose();
});

const insert = (n: number) =>
	query((db) => db.execute(sql.raw(`insert into "${table}" (n) values (${n})`)));

const count = query((db) =>
	Effect.map(
		db.execute<{ n: number }>(sql.raw(`select count(*)::int as n from "${table}"`), "objects"),
		([row]) => row?.n,
	),
);

class Rejected extends Data.TaggedError("Rejected") {}

it("rejects with the original typed failure or defect at the promise boundary", async () => {
	const runEffect = effectRunner(runtime);
	const rejected = new Rejected();
	const defect = new Error("driver fault");
	await expect(runEffect(Effect.fail(rejected))).rejects.toBe(rejected);
	await expect(runEffect(Effect.fail(undefined))).rejects.toBeUndefined();
	await expect(runEffect(Effect.die(defect))).rejects.toBe(defect);
});

it("sees transaction writes before committing them", async () => {
	const seen = await run(
		transaction(
			Effect.gen(function* () {
				yield* insert(1);
				// Uncommitted, so only the transaction's own connection can see it.
				return yield* count;
			}),
		),
	);

	expect(seen).toStrictEqual(Exit.succeed(1));
	expect(await run(count)).toStrictEqual(Exit.succeed(1));
});

it("rolls back on failure, and hands the caller its own error", async () => {
	const exit = await run(
		transaction(
			Effect.gen(function* () {
				yield* insert(2);
				return yield* new Rejected();
			}),
		),
	);

	expect(exit).toStrictEqual(Exit.fail(new Rejected()));
	expect(await run(count)).toStrictEqual(Exit.succeed(1));
});

it("rolls back on a defect", async () => {
	const boom = new Error("boom");
	const exit = await run(
		transaction(
			Effect.gen(function* () {
				yield* insert(3);
				return yield* Effect.die(boom);
			}),
		),
	);

	expect(exit).toStrictEqual(Exit.die(boom));
	expect(await run(count)).toStrictEqual(Exit.succeed(1));
});

it("rolls back when interrupted, and waits for the rollback", async () => {
	const inserted = Deferred.makeUnsafe<void>();
	let announced = false;
	const started = runtime.runFork(
		transaction(
			Effect.gen(function* () {
				yield* insert(4);
				yield* afterCommit(
					Effect.sync(() => {
						announced = true;
					}),
				);
				yield* Deferred.succeed(inserted, undefined);
				return yield* Effect.never;
			}),
		),
	);

	await Effect.runPromise(Deferred.await(inserted));
	await Effect.runPromise(Fiber.interrupt(started));
	const exit = await Effect.runPromise(Fiber.await(started));

	expect(Exit.isFailure(exit) && Cause.hasInterruptsOnly(exit.cause)).toBe(true);
	expect(announced).toBe(false);
	expect(await run(count)).toStrictEqual(Exit.succeed(1));
});

it("inherits services and references across transaction and savepoint callbacks", async () => {
	class Request extends Context.Service<Request, string>()("database.test/Request") {}
	const Local = Context.Reference("database.test/Local", { defaultValue: () => "default" });
	const readContext = Effect.gen(function* () {
		return [yield* Request, yield* Local];
	});
	const exit = await run(
		transaction(
			Effect.gen(function* () {
				const outer = yield* readContext;
				const inner = yield* transaction(readContext);
				return { outer, inner };
			}),
		).pipe(Effect.provideService(Request, "request"), Effect.provideService(Local, "local")),
	);
	expect(exit).toStrictEqual(
		Exit.succeed({
			outer: ["request", "local"],
			inner: ["request", "local"],
		}),
	);
});

it("rolls back only the inner work when a nested transaction fails", async () => {
	const exit = await run(
		transaction(
			Effect.gen(function* () {
				yield* insert(10);
				// The outer transaction recovers from the inner failure, and the
				// inner write must still roll back, so a helper is atomic whether
				// it runs on its own or inside another service's transaction.
				yield* transaction(
					Effect.gen(function* () {
						yield* insert(20);
						return yield* new Rejected();
					}),
				).pipe(Effect.catchTag("Rejected", () => Effect.void));
				return yield* count;
			}),
		),
	);

	expect(exit).toStrictEqual(Exit.succeed(2));
	await run(query((db) => db.execute(sql.raw(`delete from "${table}" where n = 10`))));
});

it("leaves a transaction usable after a recognised conflict is recovered", async () => {
	const exit = await run(
		transaction(
			Effect.gen(function* () {
				// Postgres aborts a transaction on a constraint violation. Recovering
				// without a savepoint would leave every later statement failing.
				yield* queryCatching(
					(db) => db.execute(sql.raw(`insert into "${table}" (n) values (1)`)),
					(failure) => (isUniqueViolation(failure) ? new Rejected() : undefined),
				).pipe(Effect.catchTag("Rejected", () => Effect.void));
				yield* insert(99);
				return yield* count;
			}),
		),
	);

	expect(exit).toStrictEqual(Exit.succeed(2));
	await run(query((db) => db.execute(sql.raw(`delete from "${table}" where n = 99`))));
});

it("commits a nested transaction with the one that contains it", async () => {
	const exit = await run(
		transaction(
			Effect.gen(function* () {
				yield* insert(5);
				yield* transaction(insert(6));
				return yield* count;
			}),
		),
	);

	expect(exit).toStrictEqual(Exit.succeed(3));
	expect(await run(count)).toStrictEqual(Exit.succeed(3));
});

it("runs work deferred with afterCommit only once the transaction has committed", async () => {
	const order: string[] = [];
	// A second connection sees only committed rows, so what it counts inside the
	// deferred work tells us whether the commit had happened by then.
	const countFromOutside = Effect.promise(async () => {
		const seen = await runtime.runPromise(count);
		order.push(`after-commit sees ${seen}`);
	});

	await run(
		transaction(
			Effect.gen(function* () {
				yield* afterCommit(countFromOutside);
				yield* insert(7);
				order.push("body done");
			}),
		),
	);

	expect(order).toEqual(["body done", "after-commit sees 4"]);
	await run(query((db) => db.execute(sql.raw(`delete from "${table}" where n = 7`))));
});

it("drops deferred work when the transaction rolls back", async () => {
	let ran = false;
	await run(
		transaction(
			Effect.gen(function* () {
				yield* afterCommit(
					Effect.sync(() => {
						ran = true;
					}),
				);
				return yield* new Rejected();
			}),
		),
	);

	expect(ran).toBe(false);
});

it("defers work from a nested transaction to the outermost commit", async () => {
	const order: string[] = [];
	await run(
		transaction(
			Effect.gen(function* () {
				yield* transaction(
					afterCommit(
						Effect.sync(() => {
							order.push("inner deferred");
						}),
					),
				);
				order.push("outer body continues");
			}),
		),
	);

	expect(order).toEqual(["outer body continues", "inner deferred"]);
});

it("drops work deferred inside a savepoint that rolls back, but keeps the outer transaction's", async () => {
	const ran: string[] = [];
	const deferred = (label: string) =>
		afterCommit(
			Effect.sync(() => {
				ran.push(label);
			}),
		);
	await run(
		transaction(
			Effect.gen(function* () {
				yield* deferred("outer");
				// The inner failure is recovered, so the outer transaction commits;
				// the inner announcement must not be made, because its write is gone.
				yield* transaction(Effect.andThen(deferred("inner"), Effect.fail(new Rejected()))).pipe(
					Effect.catchTag("Rejected", () => Effect.void),
				);
			}),
		),
	);

	expect(ran).toEqual(["outer"]);
});

it("runs afterCommit work immediately when there is no transaction", async () => {
	let ran = false;
	await run(
		afterCommit(
			Effect.sync(() => {
				ran = true;
			}),
		),
	);

	expect(ran).toBe(true);
});

it("flushes a batch once, after the beforeCommit work, with what every surviving savepoint added", async () => {
	const order: string[] = [];
	const gather = batchedBeforeCommit((labels: readonly string[]) =>
		Effect.sync(() => {
			order.push(`flushed ${labels.join(", ")}`);
		}),
	);
	await run(
		transaction(
			Effect.gen(function* () {
				yield* gather(["outer"]);
				yield* transaction(gather(["kept savepoint"]));
				yield* transaction(
					Effect.andThen(gather(["lost savepoint"]), Effect.fail(new Rejected())),
				).pipe(Effect.catchTag("Rejected", () => Effect.void));
				yield* beforeCommit(
					Effect.andThen(
						Effect.sync(() => {
							order.push("before commit");
						}),
						gather(["from before commit"]),
					),
				);
			}),
		),
	);

	expect(order).toEqual(["before commit", "flushed outer, kept savepoint, from before commit"]);
});
