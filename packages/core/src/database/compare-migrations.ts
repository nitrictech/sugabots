/**
 * Proves two ways of upgrading `main`'s database the same: the migrations
 * after `main`'s newest as they were at a git revision, and as they are in the
 * working tree. Used to check that a squashed migration does what the chain it
 * replaced did.
 *
 *   bun run --cwd packages/core db:compare-migrations <revision>
 *
 * For each seed, an installation as `main` left it (with and without a
 * summary's model request) and an empty one, it
 * migrates a database to `main`'s newest migration and writes the seed, copies
 * it twice, runs the revision's later migrations on one copy and the working
 * tree's on the other, then compares their schemas (tables, columns, types,
 * defaults, constraints, indexes, triggers, functions, views, sequences,
 * types, extensions, policies, rules and comments) and every table's rows.
 * Drizzle's own bookkeeping, the `drizzle` schema, is left out.
 *
 * Two runs of the same migrations differ in what they generate, so before
 * rows are compared, each id the seed didn't hold is named after the table
 * whose primary key holds it and its place among that table's new ids, in the
 * order it was made, and each time inside the migration's run is replaced by a
 * placeholder.
 *
 * Runs against the server of the test database (`TEST_DATABASE_URL`, or
 * `DATABASE_URL`'s with `_test` on its name), in databases named after it with
 * `_compare_seed`, `_compare_before` and `_compare_after` on the end, which it
 * drops when it is done. Exits with 1 when anything differs.
 */

import { execFileSync } from "node:child_process";
import { mkdir, mkdtemp, readdir, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { PgClient } from "@effect/sql-pg";
import { makeWithDefaults } from "drizzle-orm/effect-postgres";
import { migrate } from "drizzle-orm/effect-postgres/migrator";
import { Effect, Layer, Redacted } from "effect";
import pg from "pg";
import { testDatabaseUrl } from "./test-database.ts";
import {
	LAST_MAIN_MIGRATION,
	legacyBytes,
	legacyComparisonRows,
	legacyRows,
	legacySummaryRequest,
} from "./upgrade.test-support.ts";

const MIGRATIONS = join(dirname(fileURLToPath(import.meta.url)), "../../drizzle");
const MIGRATIONS_IN_REPOSITORY = "packages/core/drizzle";

/** Schemas Postgres and Drizzle own, which no migration of ours writes. */
const SKIPPED_SCHEMAS = ["pg_catalog", "information_schema", "drizzle"];

/** How many differing rows of one table to print. */
const ROWS_SHOWN = 5;

interface Seed {
	name: string;
	/** Writes the seed to a database at `main`'s newest migration. */
	write: (client: pg.Client) => Promise<void>;
}

/** An installation's rows, and its bytes as the Postgres blob store keeps them. */
async function writeInstallation(client: pg.Client) {
	await client.query(legacyRows);
	await client.query(legacyComparisonRows);
	for (const { key, text } of legacyBytes) {
		await client.query(
			`insert into blob (key, bytes, content_type, size) values ($1, $2, 'text/plain', $3)`,
			[key, Buffer.from(text), Buffer.byteLength(text)],
		);
	}
}

const SEEDS: readonly Seed[] = [
	{ name: "an installation as main left it", write: writeInstallation },
	{
		name: "the same installation, with a summary's model request",
		write: async (client) => {
			await writeInstallation(client);
			await client.query(legacySummaryRequest);
		},
	},
	{ name: "an empty installation", write: async () => {} },
];

/** Compares `revision`'s migrations after `main`'s with the working tree's; returns the exit code. */
async function compare(revision: string | undefined): Promise<number> {
	if (!revision) {
		console.error("Usage: compare-migrations.ts <git revision whose later migrations to compare>");
		return 2;
	}
	const serverUrl = testDatabaseUrl(process.env);
	if (!serverUrl) {
		console.error("Set DATABASE_URL or TEST_DATABASE_URL to a Postgres server to compare on.");
		return 2;
	}

	const databases = {
		seed: databaseUrl(serverUrl, "_compare_seed"),
		before: databaseUrl(serverUrl, "_compare_before"),
		after: databaseUrl(serverUrl, "_compare_after"),
	};
	const folders = await mkdtemp(join(tmpdir(), "compare-migrations-"));
	let differences = 0;
	try {
		const mainMigrations = (await readdir(MIGRATIONS)).filter(
			(name) => name <= LAST_MAIN_MIGRATION,
		);
		const beforeFolder = await migrationsAt(revision, join(folders, "before"), mainMigrations);
		const afterFolder = await workingTreeMigrations(join(folders, "after"));
		const mainFolder = await linkedMigrations(join(folders, "main"), mainMigrations);
		for (const seed of SEEDS) {
			console.log(`\n${seed.name}:`);
			await recreateDatabase(databases.seed);
			await runMigrations(databases.seed, mainFolder);
			await withClient(databases.seed, seed.write);
			const seeded = await idsIn(databases.seed);
			const before = await migratedCopy(databases.seed, databases.before, beforeFolder, seeded);
			const after = await migratedCopy(databases.seed, databases.after, afterFolder, seeded);
			if ("failed" in before || "failed" in after) {
				for (const [side, migrated] of Object.entries({ before, after })) {
					if ("failed" in migrated)
						console.log(`  ${side}: the migrations failed: ${migrated.failed}`);
				}
				differences += 1;
				continue;
			}
			const rows = compareRows(before.rows, after.rows);
			const found = [...compareSchemas(before.schema, after.schema), ...rows.differences];
			for (const line of found) console.log(`  ${line}`);
			for (const table of rows.reordered) {
				console.log(
					`  ${table}: the same rows, but the ids made for them were made in another order`,
				);
			}
			console.log(
				found.length === 0
					? `  same schema and rows (${Object.keys(after.rows).length} tables, ${countRows(after.rows)} rows)`
					: `  ${found.length} differences`,
			);
			differences += found.length;
		}
	} finally {
		for (const url of Object.values(databases)) await dropDatabase(url);
		await rm(folders, { recursive: true, force: true });
	}
	return differences === 0 ? 0 : 1;
}

type Migrated =
	| { schema: Record<string, string[]>; rows: Record<string, string[]> }
	| { failed: string };

/**
 * Copies the seed database, runs `folder`'s migrations on the copy and reads
 * what they left, or the error they stopped at.
 */
async function migratedCopy(
	seedUrl: string,
	url: string,
	folder: string,
	seeded: ReadonlySet<string>,
): Promise<Migrated> {
	await dropDatabase(url);
	await withServer(url, (client, name) =>
		client.query(`create database ${quoted(name)} template ${quoted(databaseName(seedUrl))}`),
	);
	const started = await clockAt(url);
	try {
		await runMigrations(url, folder);
	} catch (error) {
		return { failed: databaseErrorOf(error) };
	}
	const finished = await clockAt(url);
	return {
		schema: await schemaOf(url),
		rows: await rowsOf(url, seeded, { from: started - 1, to: finished + 1 }),
	};
}

/** What Postgres said about the statement a migration stopped at. */
function databaseErrorOf(error: unknown): string {
	let cause: unknown = error;
	while (cause instanceof Error && cause.cause) cause = cause.cause;
	return cause instanceof Error ? cause.message : String(cause);
}

/** `main`'s migrations, and those after them at `revision`, written to `folder`. */
async function migrationsAt(revision: string, folder: string, mainMigrations: readonly string[]) {
	await linkedMigrations(folder, mainMigrations);
	const listed = git(["ls-tree", "-d", "--name-only", `${revision}:${MIGRATIONS_IN_REPOSITORY}`]);
	const later = listed.split("\n").filter((name) => name > LAST_MAIN_MIGRATION);
	for (const name of later) {
		await mkdir(join(folder, name));
		const sql = git(["show", `${revision}:${MIGRATIONS_IN_REPOSITORY}/${name}/migration.sql`]);
		await writeFile(join(folder, name, "migration.sql"), sql);
	}
	console.log(`${revision}: ${later.length} migrations after ${LAST_MAIN_MIGRATION}`);
	return folder;
}

/** `main`'s migrations, and those after them in the working tree, linked into `folder`. */
async function workingTreeMigrations(folder: string) {
	const names = await readdir(MIGRATIONS);
	const later = names.filter((name) => name > LAST_MAIN_MIGRATION);
	console.log(`working tree: ${later.join(", ")}`);
	return linkedMigrations(folder, names);
}

async function linkedMigrations(folder: string, names: readonly string[]) {
	await mkdir(folder, { recursive: true });
	for (const name of names) await symlink(join(MIGRATIONS, name), join(folder, name));
	return folder;
}

function git(args: string[]): string {
	const repository = execFileSync("git", ["rev-parse", "--show-toplevel"], {
		cwd: MIGRATIONS,
		encoding: "utf8",
	}).trim();
	return execFileSync("git", args, { cwd: repository, encoding: "utf8", maxBuffer: 64 << 20 });
}

async function runMigrations(url: string, folder: string) {
	await Effect.runPromise(
		Effect.gen(function* () {
			const db = yield* makeWithDefaults();
			yield* migrate(db, { migrationsFolder: folder, migrationsTable: "__drizzle_migrations" });
		}).pipe(Effect.provide(PgClient.layer({ url: Redacted.make(url) }).pipe(Layer.orDie))),
	);
}

/** The server's clock, in milliseconds since the epoch. */
async function clockAt(url: string): Promise<number> {
	return withClient(url, async (client) => {
		const { rows } = await client.query<{ at: Date }>(`select clock_timestamp() as at`);
		const [clock] = rows;
		if (!clock) throw new Error("The server didn't say what time it is.");
		return clock.at.getTime();
	});
}

/** Each kind of schema object, as one sorted line per object, from the system catalogs. */
async function schemaOf(url: string): Promise<Record<string, string[]>> {
	const skipped = `(${SKIPPED_SCHEMAS.map((name) => `'${name}'`).join(", ")})`;
	const ours = (namespace: string) =>
		`${namespace}.nspname not in ${skipped} and ${namespace}.nspname not like 'pg\\_%'`;
	const queries: Record<string, string> = {
		schemas: `select n.nspname from pg_namespace n where ${ours("n")}`,
		extensions: `select e.extname, e.extversion, n.nspname from pg_extension e join pg_namespace n on n.oid = e.extnamespace`,
		relations: `select n.nspname, c.relname, c.relkind, c.relpersistence, c.relrowsecurity, c.relforcerowsecurity, c.relreplident
			from pg_class c join pg_namespace n on n.oid = c.relnamespace
			where ${ours("n")} and c.relkind in ('r', 'p', 'v', 'm', 'S', 'f', 'c')`,
		// A column's place among its table's columns, not its number, which
		// counts the columns dropped before it.
		columns: `select n.nspname, c.relname, a.attname,
				row_number() over (partition by a.attrelid order by a.attnum) as position,
				format_type(a.atttypid, a.atttypmod), a.attnotnull, a.attidentity, a.attgenerated,
				pg_get_expr(d.adbin, d.adrelid) as default_value, co.collname, a.attndims
			from pg_attribute a
			join pg_class c on c.oid = a.attrelid
			join pg_namespace n on n.oid = c.relnamespace
			left join pg_attrdef d on d.adrelid = a.attrelid and d.adnum = a.attnum
			left join pg_collation co on co.oid = a.attcollation and a.attcollation <> 0 and co.collname <> 'default'
			where ${ours("n")} and c.relkind in ('r', 'p', 'v', 'm', 'f', 'c') and a.attnum > 0 and not a.attisdropped`,
		constraints: `select n.nspname, c.relname, k.conname, k.contype, pg_get_constraintdef(k.oid),
				k.condeferrable, k.condeferred, k.convalidated, k.connoinherit
			from pg_constraint k
			join pg_namespace n on n.oid = k.connamespace
			left join pg_class c on c.oid = k.conrelid
			where ${ours("n")}`,
		indexes: `select n.nspname, c.relname, pg_get_indexdef(i.indexrelid), i.indisprimary, i.indisunique,
				i.indisvalid, i.indisreplident, i.indnullsnotdistinct
			from pg_index i
			join pg_class c on c.oid = i.indexrelid
			join pg_namespace n on n.oid = c.relnamespace
			where ${ours("n")}`,
		triggers: `select n.nspname, c.relname, t.tgname, pg_get_triggerdef(t.oid), t.tgenabled
			from pg_trigger t
			join pg_class c on c.oid = t.tgrelid
			join pg_namespace n on n.oid = c.relnamespace
			where ${ours("n")} and not t.tgisinternal`,
		functions: `select n.nspname, p.proname, pg_get_function_identity_arguments(p.oid), p.prokind,
				case when p.prokind in ('f', 'p') then pg_get_functiondef(p.oid) end
			from pg_proc p join pg_namespace n on n.oid = p.pronamespace
			where ${ours("n")}
				and not exists (select 1 from pg_depend d where d.objid = p.oid and d.deptype = 'e')`,
		views: `select n.nspname, c.relname, c.relkind, pg_get_viewdef(c.oid, true)
			from pg_class c join pg_namespace n on n.oid = c.relnamespace
			where ${ours("n")} and c.relkind in ('v', 'm')`,
		sequences: `select n.nspname, c.relname, format_type(s.seqtypid, null), s.seqstart, s.seqincrement,
				s.seqmax, s.seqmin, s.seqcache, s.seqcycle, owner_table.relname as owned_by_table, owner_column.attname as owned_by_column
			from pg_sequence s
			join pg_class c on c.oid = s.seqrelid
			join pg_namespace n on n.oid = c.relnamespace
			left join pg_depend d on d.objid = s.seqrelid and d.classid = 'pg_class'::regclass and d.refclassid = 'pg_class'::regclass and d.deptype in ('a', 'i')
			left join pg_class owner_table on owner_table.oid = d.refobjid
			left join pg_attribute owner_column on owner_column.attrelid = d.refobjid and owner_column.attnum = d.refobjsubid
			where ${ours("n")}`,
		types: `select n.nspname, t.typname, t.typtype, format_type(t.typbasetype, t.typtypmod), t.typnotnull, t.typdefault,
				(select string_agg(e.enumlabel, ',' order by e.enumsortorder) from pg_enum e where e.enumtypid = t.oid) as labels
			from pg_type t join pg_namespace n on n.oid = t.typnamespace
			where ${ours("n")} and t.typtype in ('e', 'd', 'r', 'm')`,
		policies: `select schemaname, tablename, policyname, permissive, roles::text, cmd, qual, with_check
			from pg_policies where schemaname not in ${skipped}`,
		rules: `select schemaname, tablename, rulename, definition from pg_rules where schemaname not in ${skipped}`,
		comments: `select n.nspname, c.relname, a.attname, d.description
			from pg_description d
			join pg_class c on c.oid = d.objoid and d.classoid = 'pg_class'::regclass
			join pg_namespace n on n.oid = c.relnamespace
			left join pg_attribute a on a.attrelid = c.oid and a.attnum = d.objsubid and d.objsubid > 0
			where ${ours("n")}`,
	};
	return withClient(url, async (client) => {
		const schema: Record<string, string[]> = {};
		for (const [kind, query] of Object.entries(queries)) {
			const { rows } = await client.query(query);
			schema[kind] = rows.map((row) => JSON.stringify(Object.values(row))).sort();
		}
		return schema;
	});
}

interface Table {
	schema: string;
	name: string;
	/** Its primary key's column, when it has a primary key of one column. */
	key: string | null;
}

async function tablesOf(client: pg.Client): Promise<Table[]> {
	const { rows } = await client.query<Table>(
		`select n.nspname as schema, c.relname as name,
			(select a.attname from pg_index i
				join pg_attribute a on a.attrelid = i.indrelid and a.attnum = i.indkey[0]
				where i.indrelid = c.oid and i.indisprimary and i.indnkeyatts = 1) as key
		from pg_class c join pg_namespace n on n.oid = c.relnamespace
		where c.relkind in ('r', 'p') and n.nspname not in (${SKIPPED_SCHEMAS.map((name) => `'${name}'`).join(", ")})
			and n.nspname not like 'pg\\_%'
		order by 1, 2`,
	);
	return rows;
}

const UUID = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/g;
const WHOLE_UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

/** Every id anywhere in the database's rows. */
async function idsIn(url: string): Promise<Set<string>> {
	return withClient(url, async (client) => {
		const ids = new Set<string>();
		for (const table of await tablesOf(client)) {
			for (const row of await rowsOfTable(client, table)) {
				for (const id of JSON.stringify(row).match(UUID) ?? []) ids.add(id);
			}
		}
		return ids;
	});
}

async function rowsOfTable(client: pg.Client, table: Table): Promise<unknown[]> {
	const { rows } = await client.query<{ row: unknown }>(
		`select to_jsonb(t) as row from ${quoted(table.schema)}.${quoted(table.name)} t`,
	);
	return rows.map(({ row }) => row);
}

interface Window {
	from: number;
	to: number;
}

/**
 * Every table's rows, and every sequence's position, as sorted lines, with the
 * ids and times the migrations made replaced by names that are the same in
 * any run that makes them in the same order.
 */
async function rowsOf(
	url: string,
	seeded: ReadonlySet<string>,
	during: Window,
): Promise<Record<string, string[]>> {
	return withClient(url, async (client) => {
		const tables = await tablesOf(client);
		const rowsByTable = new Map<Table, unknown[]>();
		for (const table of tables) rowsByTable.set(table, await rowsOfTable(client, table));

		const named = namesOfMadeIds(rowsByTable, seeded, during);
		const result: Record<string, string[]> = {};
		for (const [table, rows] of rowsByTable) {
			result[`${table.schema}.${table.name}`] = rows
				.map((row) =>
					JSON.stringify(canonical(row, during)).replace(UUID, (id) => named.get(id) ?? id),
				)
				.sort();
		}
		const { rows: sequences } = await client.query<{ schema: string; name: string }>(
			`select schemaname as schema, sequencename as name from pg_sequences
			where schemaname not in (${SKIPPED_SCHEMAS.map((name) => `'${name}'`).join(", ")})`,
		);
		for (const sequence of sequences) {
			const { rows } = await client.query(
				`select last_value, is_called from ${quoted(sequence.schema)}.${quoted(sequence.name)}`,
			);
			result[`sequence ${sequence.schema}.${sequence.name}`] = rows.map((row) =>
				JSON.stringify(row),
			);
		}
		return result;
	});
}

/**
 * A name for each id the migrations made: the table whose primary key holds
 * it and its place among that table's made ids, or, for one no primary key
 * holds, its place among those.
 */
function namesOfMadeIds(
	rowsByTable: ReadonlyMap<Table, unknown[]>,
	seeded: ReadonlySet<string>,
	during: Window,
): Map<string, string> {
	const named = new Map<string, string>();
	const masked = (row: unknown) =>
		JSON.stringify(canonical(row, during)).replace(UUID, (id) => (seeded.has(id) ? id : "<made>"));
	for (const [table, rows] of rowsByTable) {
		const key = table.key;
		if (!key) continue;
		const made = rows
			.map((row) => ({ id: String((row as Record<string, unknown>)[key]), row }))
			.filter(({ id }) => WHOLE_UUID.test(id) && !seeded.has(id) && !named.has(id))
			.sort((a, b) => compareText(madeOrder(a.id, a.row, masked), madeOrder(b.id, b.row, masked)));
		for (const [place, { id }] of made.entries()) named.set(id, `<${table.name} ${place + 1}>`);
	}
	const unplaced = [...rowsByTable.values()]
		.flatMap((rows) => rows.flatMap((row) => JSON.stringify(row).match(UUID) ?? []))
		.filter((id) => !seeded.has(id) && !named.has(id))
		.sort();
	for (const id of new Set(unplaced)) named.set(id, `<made ${named.size + 1}>`);
	return named;
}

/** Where a UUID keeps its version, 7 for one ordered by when it was made. */
const UUID_VERSION_INDEX = 14;

/**
 * Where an id the migrations made sorts among its table's: a time-ordered id
 * by when it was made, a random one by the row it keys.
 */
function madeOrder(id: string, row: unknown, masked: (row: unknown) => string): string {
	return id[UUID_VERSION_INDEX] === "7" ? `7 ${id}` : `4 ${masked(row)}`;
}

const TIMESTAMP = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?([+-]\d{2}:\d{2}|Z)$/;

/** `value` with object keys sorted and times inside `during` replaced. */
function canonical(value: unknown, during: Window): unknown {
	if (typeof value === "string" && TIMESTAMP.test(value)) {
		const at = Date.parse(value);
		return at >= during.from && at <= during.to ? "<during the migration>" : value;
	}
	if (Array.isArray(value)) return value.map((item) => canonical(item, during));
	if (value && typeof value === "object") {
		return Object.fromEntries(
			Object.keys(value)
				.sort()
				.map((key) => [key, canonical((value as Record<string, unknown>)[key], during)]),
		);
	}
	return value;
}

function compareSchemas(
	before: Record<string, string[]>,
	after: Record<string, string[]>,
): string[] {
	return Object.keys(before).flatMap((kind) =>
		linesDiffering(`${kind}:`, before[kind] ?? [], after[kind] ?? [], Number.POSITIVE_INFINITY),
	);
}

interface RowComparison {
	differences: string[];
	/** Tables whose rows are the same but for the order the ids made for them were made in. */
	reordered: string[];
}

function compareRows(
	before: Record<string, string[]>,
	after: Record<string, string[]>,
): RowComparison {
	const comparison: RowComparison = { differences: [], reordered: [] };
	const tables = [...new Set([...Object.keys(before), ...Object.keys(after)])].sort();
	for (const table of tables) {
		const was = before[table];
		const is = after[table];
		if (!was || !is) {
			comparison.differences.push(`${table}: only ${was ? "before" : "after"}`);
			continue;
		}
		const differing = linesDiffering(`${table}:`, was, is, ROWS_SHOWN);
		if (differing.length === 0) continue;
		if (sameButForMadeOrder(table, before, after)) comparison.reordered.push(table);
		else comparison.differences.push(...differing);
	}
	return comparison;
}

/**
 * Whether `table`'s rows differ only in which of the ids made for them each
 * got, while no other table names those ids: the same rows, made in another
 * order.
 */
function sameButForMadeOrder(
	table: string,
	before: Record<string, string[]>,
	after: Record<string, string[]>,
): boolean {
	const name = table.slice(table.indexOf(".") + 1);
	const madeId = `<${name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")} \\d+>`;
	const named = new RegExp(madeId);
	const namedElsewhere = (rows: Record<string, string[]>) =>
		Object.entries(rows).some(
			([other, lines]) => other !== table && lines.some((line) => named.test(line)),
		);
	if (namedElsewhere(before) || namedElsewhere(after)) return false;
	const unordered = (lines: readonly string[]) =>
		lines.map((line) => line.replace(new RegExp(madeId, "g"), `<${name}>`)).sort();
	return (
		JSON.stringify(unordered(before[table] ?? [])) === JSON.stringify(unordered(after[table] ?? []))
	);
}

/** The lines only one side has, each side's counted against the other's. */
function linesDiffering(
	label: string,
	before: readonly string[],
	after: readonly string[],
	shown: number,
): string[] {
	const onlyBefore = without(before, after);
	const onlyAfter = without(after, before);
	return [
		...onlyBefore.slice(0, shown).map((line) => `${label} only before: ${line}`),
		...onlyAfter.slice(0, shown).map((line) => `${label} only after: ${line}`),
		...(onlyBefore.length + onlyAfter.length > 2 * shown
			? [`${label} ${onlyBefore.length} only before, ${onlyAfter.length} only after in all`]
			: []),
	];
}

function without(lines: readonly string[], removed: readonly string[]): string[] {
	const counts = new Map<string, number>();
	for (const line of removed) counts.set(line, (counts.get(line) ?? 0) + 1);
	return lines.filter((line) => {
		const left = counts.get(line) ?? 0;
		if (left === 0) return true;
		counts.set(line, left - 1);
		return false;
	});
}

function countRows(rows: Record<string, string[]>): number {
	return Object.values(rows).reduce((total, lines) => total + lines.length, 0);
}

function compareText(a: string, b: string): number {
	return a < b ? -1 : a > b ? 1 : 0;
}

function databaseUrl(url: string, suffix: string): string {
	const parsed = new URL(url);
	parsed.pathname = `${parsed.pathname}${suffix}`;
	return parsed.toString();
}

function databaseName(url: string): string {
	return new URL(url).pathname.replace(/^\//, "");
}

async function recreateDatabase(url: string) {
	await dropDatabase(url);
	await withServer(url, (client, name) => client.query(`create database ${quoted(name)}`));
}

async function dropDatabase(url: string) {
	await withServer(url, (client, name) =>
		client.query(`drop database if exists ${quoted(name)} with (force)`),
	);
}

/** Runs `use` connected to the server's default database, with the name of the database at `url`. */
async function withServer<A>(url: string, use: (client: pg.Client, name: string) => Promise<A>) {
	const server = new URL(url);
	server.pathname = "/postgres";
	return withClient(server.toString(), (client) => use(client, databaseName(url)));
}

async function withClient<A>(url: string, use: (client: pg.Client) => Promise<A>): Promise<A> {
	const client = new pg.Client({ connectionString: url });
	await client.connect();
	try {
		return await use(client);
	} finally {
		await client.end();
	}
}

function quoted(name: string): string {
	return `"${name.replace(/"/g, '""')}"`;
}

process.exit(await compare(process.argv[2]));
