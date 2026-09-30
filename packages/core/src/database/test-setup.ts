import { PgClient } from "@effect/sql-pg";
import { Effect, Layer, Redacted } from "effect";
import type { TestProject } from "vitest/node";
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
 * The test files do not run against it: it is the template each Vitest worker
 * copies into a database of its own (see `test-worker-setup.ts`), so files in
 * different workers never see each other's rows or claim each other's jobs.
 * The copies from the last run are dropped here, and each worker makes its
 * copy afresh from the emptied template.
 *
 * `testDatabaseUrl` is what decides the database, and it refuses the
 * development one — this truncates every table, so being sure of that first is
 * the whole point.
 */

declare module "vitest" {
	interface ProvidedContext {
		/** The migrated, empty database each worker copies, or `undefined` without one. */
		testDatabaseTemplateUrl: string | undefined;
	}
}

/**
 * Vitest runs this in its own process, which has not loaded a `.env`, so the
 * URL comes from the project's resolved env — the same one the test files get
 * — rather than from `process.env`, which is usually empty here.
 */
export default async function prepareTestDatabase(project: TestProject): Promise<void> {
	const url = project.config.env?.DATABASE_URL ?? testDatabaseUrl(process.env);
	project.provide("testDatabaseTemplateUrl", url);
	if (!url) {
		return;
	}
	await Effect.runPromise(createIfMissing(url));
	await Effect.runPromise(Effect.andThen(applyMigrations, empty).pipe(Effect.provide(poolAt(url))));
	await Effect.runPromise(dropWorkerCopies(url));
}

/**
 * Copies the template into the database at `url` unless a worker already made
 * it this run. The template must have no open connections, which holds once
 * `prepareTestDatabase` has finished with it.
 */
export function copyTemplateIfMissing(url: string, templateUrl: string): Effect.Effect<void> {
	const template = databaseName(templateUrl);
	return withServer(url, (client, name) =>
		Effect.gen(function* () {
			if (yield* exists(client, name)) {
				return;
			}
			yield* client.unsafe(`create database ${identifier(name)} template ${identifier(template)}`);
		}),
	);
}

/** Creates the database at `url` if the server has none by that name. */
function createIfMissing(url: string): Effect.Effect<void> {
	return withServer(url, (client, name) =>
		Effect.gen(function* () {
			if (yield* exists(client, name)) {
				return;
			}
			yield* client.unsafe(`create database ${identifier(name)}`);
		}),
	);
}

/** Drops every worker's copy of the template at `templateUrl`, from a previous run. */
function dropWorkerCopies(templateUrl: string): Effect.Effect<void> {
	return withServer(templateUrl, (client, template) =>
		Effect.gen(function* () {
			const copies = yield* client.unsafe<{ name: string }>(
				`select datname as name from pg_database
				 where starts_with(datname, $1) and substr(datname, length($1) + 1) ~ '^[0-9]+$'`,
				[`${template}_`],
			);
			for (const copy of copies) {
				yield* client.unsafe(`drop database ${identifier(copy.name)} with (force)`);
			}
		}),
	);
}

/**
 * Runs `use` connected to the server's default database, which is where
 * databases are created and dropped, with the name of the database at `url`.
 */
function withServer(
	url: string,
	use: (client: PgClient.PgClient, name: string) => Effect.Effect<void, unknown>,
): Effect.Effect<void> {
	const server = new URL(url);
	server.pathname = "/postgres";
	return Effect.flatMap(PgClient.PgClient, (client) => use(client, databaseName(url))).pipe(
		Effect.orDie,
		Effect.provide(poolAt(server.toString())),
	);
}

function exists(client: PgClient.PgClient, name: string) {
	return Effect.map(
		client.unsafe("select 1 from pg_database where datname = $1", [name]),
		(rows) => rows.length > 0,
	);
}

function databaseName(url: string): string {
	return new URL(url).pathname.replace(/^\//, "");
}

/**
 * A database name quoted for SQL. The names come from a URL rather than from a
 * request, and Postgres has no parameter form for an identifier here.
 */
function identifier(name: string): string {
	return `"${name.replace(/"/g, '""')}"`;
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
