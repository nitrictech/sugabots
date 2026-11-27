import { sql } from "drizzle-orm";
import { Effect, Exit } from "effect";
import { afterAll, describe, expect, it } from "vitest";
import { query } from "./database.ts";
import { isRetryableTransactionError } from "./errors.ts";
import { closeDatabase, runOnPostgres } from "./testing.ts";

/**
 * How a query ends when Postgres raises SQLSTATE `code`, as the cause a caller
 * catches it by, through every wrapper around the server's error.
 */
const causeOf = (code: string) =>
	runOnPostgres(
		Effect.exit(
			query((db) =>
				db.execute(sql.raw(`do $$ begin raise exception using errcode = '${code}'; end $$`)),
			),
		).pipe(
			Effect.map((ended) => {
				if (Exit.isSuccess(ended)) throw new Error(`Postgres raised no ${code}`);
				return ended.cause;
			}),
		),
	);

describe.skipIf(!process.env.DATABASE_URL)("which Postgres errors may be retried", () => {
	afterAll(closeDatabase);

	it.each([
		["a deadlock", "40P01"],
		["a serialization failure", "40001"],
		["a lock not available", "55P03"],
		["a cancelled statement", "57014"],
		["an administrator's shutdown", "57P01"],
		["too many connections", "53300"],
		["a lost connection", "08006"],
	])("retries a transaction Postgres refused with %s (%s)", async (_error, code) => {
		expect(isRetryableTransactionError(await causeOf(code))).toBe(true);
	});

	it("does not retry a transaction that broke a constraint", async () => {
		expect(isRetryableTransactionError(await causeOf("23505"))).toBe(false);
	});
});
