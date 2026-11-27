import { query } from "@sugabots/core/database/database";
import { runOnPostgres } from "@sugabots/core/database/testing";
import { sql } from "drizzle-orm";
import { Effect } from "effect";

/**
 * Empties every table the app owns in this worker's test database. The
 * scheduler takes whatever work is due anywhere in the database, so a case
 * that runs it starts from nothing that other cases, or files this worker ran
 * before, left due. A case stops the work it started before the next begins.
 */
export const emptyDatabase = () =>
	runOnPostgres(
		Effect.gen(function* () {
			const tables = yield* query((db) =>
				db.execute<{ name: string }>(
					sql`select quote_ident(tablename) as name from pg_tables
						where schemaname = 'public' and tablename <> '__drizzle_migrations'`,
					"objects",
				),
			);
			if (tables.length === 0) return;
			yield* query((db) =>
				db.execute(sql.raw(`truncate ${tables.map(({ name }) => name).join(", ")} cascade`)),
			);
		}),
	);
