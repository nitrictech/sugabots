import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import type { PgClient } from "@effect/sql-pg";
import { makeWithDefaults } from "drizzle-orm/effect-postgres";
import { migrate } from "drizzle-orm/effect-postgres/migrator";
import { Effect } from "effect";

/** Where `drizzle-kit generate` writes migrations. */
const MIGRATIONS_FOLDER = join(dirname(fileURLToPath(import.meta.url)), "../../drizzle");

/**
 * Applies every migration the database has not seen yet, in journal order,
 * using the same `drizzle.__drizzle_migrations` bookkeeping as
 * `drizzle-kit migrate`. Not safe to run from two processes at once.
 */
export const applyMigrations: Effect.Effect<void, never, PgClient.PgClient> = Effect.gen(
	function* () {
		const db = yield* makeWithDefaults();
		yield* migrate(db, {
			migrationsFolder: MIGRATIONS_FOLDER,
			migrationsTable: "__drizzle_migrations",
		});
	},
).pipe(Effect.orDie);
