import { getTableName, is, sql } from "drizzle-orm";
import { PgTable } from "drizzle-orm/pg-core";
import { afterAll, describe, expect, it } from "vitest";
import * as schema from "./schema.ts";
import { workspace } from "./schema.ts";
import { closeDatabase, onDatabase } from "./testing.ts";

/**
 * Proves the migrations under drizzle/ have been applied and describe the
 * schema this code expects. Needs a migrated database: `docker compose up -d`
 * then `bun run db:migrate`. Without DATABASE_URL it skips, so `bun run check`
 * still passes on a machine with no Postgres. CI always provides one.
 */
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

	it("generates workspace identity and rejects a duplicate slug", async () => {
		const slug = `test-${crypto.randomUUID()}`;

		const [first] = await onDatabase((db) =>
			db.insert(workspace).values({ name: "Test", slug }).returning(),
		);
		expect(first?.id).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-/);
		expect(first?.createdAt).toBeInstanceOf(Date);

		await expect(
			onDatabase((db) => db.insert(workspace).values({ name: "Test again", slug })),
		).rejects.toThrow();

		await onDatabase((db) => db.delete(workspace).where(sql`${workspace.slug} = ${slug}`));
	});
});
