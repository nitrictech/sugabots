import { getTableName, is, sql } from "drizzle-orm";
import { PgTable } from "drizzle-orm/pg-core";
import { afterAll, describe, expect, it } from "vitest";
import * as schema from "./schema.ts";
import { closeDatabase, onDatabase } from "./testing.ts";

/** Proves the migrations under drizzle/ describe the schema this code expects. */
describe.skipIf(!process.env.DATABASE_URL)("schema", () => {
	afterAll(closeDatabase);

	it("has every table the code declares", async () => {
		const declared = Object.values(schema)
			.filter((value) => is(value, PgTable))
			.map(getTableName)
			.sort();

		const rows = await onDatabase((db) =>
			db.execute<{ table_name: string }>(
				sql`
					select table_name
					from information_schema.tables
					where table_schema = 'public' and table_type = 'BASE TABLE'
				`,
				"objects",
			),
		);
		const applied = new Set(rows.map((row) => row.table_name));

		expect(declared.filter((table) => !applied.has(table))).toEqual([]);
	});
});
