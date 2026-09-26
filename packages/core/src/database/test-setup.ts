import { PgClient } from "@effect/sql-pg";
import { Effect, Layer, Redacted } from "effect";
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
	await Effect.runPromise(createIfMissing(url));
	await Effect.runPromise(Effect.andThen(applyMigrations, empty).pipe(Effect.provide(poolAt(url))));
}

/** Connects to the server's default database to create ours. */
function createIfMissing(url: string): Effect.Effect<void> {
	const name = new URL(url).pathname.replace(/^\//, "");
	const server = new URL(url);
	server.pathname = "/postgres";

	return Effect.gen(function* () {
		const client = yield* PgClient.PgClient;
		const existing = yield* client.unsafe("select 1 from pg_database where datname = $1", [name]);
		if (existing.length === 0) {
			// The name comes from a URL rather than from a request, and Postgres
			// has no parameter form for an identifier here.
			yield* client.unsafe(`create database "${name.replace(/"/g, '""')}"`);
		}
	}).pipe(Effect.orDie, Effect.provide(poolAt(server.toString())));
}

/** Every table the app owns, emptied in one statement so foreign keys allow it. */
const empty = Effect.gen(function* () {
	const client = yield* PgClient.PgClient;
	const rows = yield* client.unsafe<{ name: string }>(
		`select quote_ident(tablename) as name from pg_tables
		 where schemaname = 'public' and tablename <> '__drizzle_migrations'`,
	);
	if (rows.length === 0) {
		return;
	}
	yield* client.unsafe(
		`truncate ${rows.map((row) => row.name).join(", ")} restart identity cascade`,
	);
}).pipe(Effect.orDie);

/** A pool at `url`: setup reaches the test database, and the server that creates it, by address. */
function poolAt(url: string) {
	return PgClient.layer({ url: Redacted.make(url) }).pipe(Layer.orDie);
}
