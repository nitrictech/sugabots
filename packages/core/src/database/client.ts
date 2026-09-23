import { drizzle, type NodePgDatabase } from "drizzle-orm/node-postgres";
import { Pool } from "pg";

/**
 * A plain drizzle handle for the seed script and the tests. The API itself
 * goes through the `Database` service in `database.ts`.
 *
 * It is built on first call rather than at import time. Importing a module that
 * happens to touch the database should not require `DATABASE_URL` to be set, or
 * a database to exist; only querying should. `new Pool` opens no socket until
 * the first query, so a process that connects and never queries costs nothing.
 */

let pool: Pool | undefined;
let db: NodePgDatabase | undefined;

/** The connection pool, opened on demand. */
function getPool(): Pool {
	if (!pool) {
		const url = process.env.DATABASE_URL;
		if (!url) {
			throw new Error("DATABASE_URL is required. Copy .env.example to .env.");
		}
		pool = new Pool({ connectionString: url });
	}
	return pool;
}

/** Drizzle bound to the shared Postgres pool. */
export function getDb(): NodePgDatabase {
	if (!db) {
		db = drizzle({ client: getPool() });
	}
	return db;
}

/** Close the pool. For scripts and tests; the server holds it until it exits. */
export async function closePool(): Promise<void> {
	await pool?.end();
	pool = undefined;
	db = undefined;
}
