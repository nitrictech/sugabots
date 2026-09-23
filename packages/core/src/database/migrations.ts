import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { drizzle } from "drizzle-orm/node-postgres";
import { migrate } from "drizzle-orm/node-postgres/migrator";
import type { Pool } from "pg";

/** Where `drizzle-kit generate` writes migrations. */
const MIGRATIONS_FOLDER = join(dirname(fileURLToPath(import.meta.url)), "../../drizzle");

/**
 * Applies every migration the database has not seen yet, in journal order,
 * using the same `drizzle.__drizzle_migrations` bookkeeping as
 * `drizzle-kit migrate`. Not safe to run from two processes at once.
 */
export async function applyMigrations(pool: Pool): Promise<void> {
	await migrate(drizzle({ client: pool }), {
		migrationsFolder: MIGRATIONS_FOLDER,
		migrationsTable: "__drizzle_migrations",
	});
}
