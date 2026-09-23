import { sql } from "drizzle-orm";
import { Cause, Context, Data, Deferred, Effect, Exit, Fiber, ManagedRuntime } from "effect";
import { Pool } from "pg";
import { afterAll, beforeAll, expect, it, vi } from "vitest";
import {
	afterCommit,
	type Database,
	effectRunner,
	layer,
	query,
	queryCatching,
	transaction,
} from "./database.ts";
import { isUniqueViolation } from "./errors.ts";

/**
 * What the transaction bridge has to guarantee, against a real Postgres.
 *
 * Everything here is about the seam in `database.ts`: an Effect runs inside
 * drizzle's promise callback and has to come back with its cause intact, and
 * the transaction has to end the way the Effect did. None of that is visible
 * from the types, so it is checked.
 */

const url = process.env.DATABASE_URL;
if (!url) {
	throw new Error("DATABASE_URL is required. Copy .env.example to .env.");
}

const database = layer(new Pool({ connectionString: url }));
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

const count = query<number>(async (db) => {
	const rows = await db.execute(sql.raw(`select count(*)::int as n from "${table}"`));
	return (rows.rows[0] as { n: number }).n;
});

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
				return yield* Effect.fail(new Rejected());
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

it("does not finish interruption until drizzle's transaction promise settles", async () => {
	const root = await runtime.runPromise(query(async (db) => db));
	const original = root.transaction.bind(root);
	const rolledBack = Promise.withResolvers<void>();
	const release = Promise.withResolvers<void>();
	const inserted = Deferred.makeUnsafe<void>();
	const transactionSpy = vi.spyOn(root, "transaction").mockImplementation(async (use, config) => {
		try {
			return await original(use, config);
		} finally {
			rolledBack.resolve();
			await release.promise;
		}
	});
	const started = runtime.runFork(
		transaction(
			Effect.gen(function* () {
				yield* insert(40);
				yield* Deferred.succeed(inserted, undefined);
				return yield* Effect.never;
			}),
		),
	);
	let interrupted = false;
	try {
		await Effect.runPromise(Deferred.await(inserted));
		const interrupting = Effect.runPromise(Fiber.interrupt(started)).then(() => {
			interrupted = true;
		});
		await rolledBack.promise;
		expect(interrupted).toBe(false);
		release.resolve();
		await interrupting;
		expect(interrupted).toBe(true);
		expect(await run(count)).toStrictEqual(Exit.succeed(1));
	} finally {
		release.resolve();
		await Effect.runPromise(Fiber.interrupt(started));
		transactionSpy.mockRestore();
	}
});

it("rolls back only the inner work when a nested transaction fails", async () => {
	const exit = await run(
		transaction(
			Effect.gen(function* () {
				yield* insert(10);
				// The inner failure is recovered by the outer, which used to leave
				// the inner write committed: a helper that is atomic when called
				// from a route and not when called from another store.
				yield* transaction(
					Effect.gen(function* () {
						yield* insert(20);
						return yield* Effect.fail(new Rejected());
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
				return yield* Effect.fail(new Rejected());
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
