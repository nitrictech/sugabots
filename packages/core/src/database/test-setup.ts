import { Pool } from "pg";
import { applyMigrations } from "./migrations.ts";
import { testDatabaseUrl } from "./test-database.ts";

/**
 * The test database, made ready once per run.
 *
 * Created if it is not there, migrated to the current schema, then emptied, so
 * a run starts from nothing and what it leaves behind is one run's worth
 * rather than every run since the database was made. Emptying here rather than
 * after each test means a failed test's rows are still there to look at.
 *
 * `testDatabaseUrl` is what decides the database, and it refuses the
 * development one — this truncates every table, so being sure of that first is
 * the whole point.
 */

/**
 * Vitest runs this in its own process, which has not loaded a `.env`, so the
 * URL comes from the project's resolved env — the same one the test files get
 * — rather than from `process.env`, which is usually empty here.
 */
export default async function prepareTestDatabase(project: {
	config: { env?: Record<string, string> };
}): Promise<void> {
	const url = project.config.env?.DATABASE_URL ?? testDatabaseUrl(process.env);
	if (!url) {
		return;
	}
	await createIfMissing(url);

	const pool = new Pool({ connectionString: url });
	try {
		await applyMigrations(pool);
		await empty(pool);
	} finally {
		await pool.end();
	}
}

/** Connects to the server's default database to create ours. */
async function createIfMissing(url: string): Promise<void> {
	const wanted = new URL(url);
	const name = wanted.pathname.replace(/^\//, "");
	const server = new URL(url);
	server.pathname = "/postgres";

	const pool = new Pool({ connectionString: server.toString() });
	try {
		const { rowCount } = await pool.query("select 1 from pg_database where datname = $1", [name]);
		if (rowCount === 0) {
			// The name comes from a URL rather than from a request, and Postgres
			// has no parameter form for an identifier here.
			await pool.query(`create database "${name.replace(/"/g, '""')}"`);
		}
	} finally {
		await pool.end();
	}
}

/** Every table the app owns, emptied in one statement so foreign keys allow it. */
async function empty(pool: Pool): Promise<void> {
	const { rows } = await pool.query<{ name: string }>(
		`select quote_ident(tablename) as name from pg_tables
		 where schemaname = 'public' and tablename <> '__drizzle_migrations'`,
	);
	if (rows.length === 0) {
		return;
	}
	await pool.query(`truncate ${rows.map((row) => row.name).join(", ")} restart identity cascade`);
}
