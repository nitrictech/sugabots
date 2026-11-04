import { execFileSync } from "node:child_process";
import { copyFileSync, existsSync, readFileSync, writeFileSync } from "node:fs";
import { createConnection } from "node:net";
import { join } from "node:path";
import { parseEnv } from "node:util";
import pg from "pg";

/*
 * A database and URLs of a worktree's own, so its branch runs beside every
 * other checkout instead of sharing the development database with them.
 *
 *   bun run db:branch          Copy the main checkout's database for this
 *                              worktree's branch, unless it already has one,
 *                              migrate it, and point this worktree's .env at
 *                              it and at the branch's Portless URLs.
 *   bun run db:branch reset    Throw this branch's database away and copy the
 *                              main checkout's again.
 *   bun run db:branch prune    Drop the databases of branches that no longer
 *                              exist. Runs from any checkout.
 *
 * The copy is a Postgres 18 clone where the filesystem shares blocks between
 * files (btrfs, XFS), and a plain copy everywhere else, which includes Docker
 * Desktop on macOS and Windows.
 */

/** Between the parent database's name and a branch's, so `prune` knows which are branches. */
const BRANCH_INFIX = "_br_";

/** What the tests add to a branch database's name for theirs: `_test`, then `_<worker>`. */
const TEST_DATABASE_SUFFIX = /_test(_\d+)?$/;

/** Postgres truncates longer identifiers, which would make two branches' names collide quietly. */
const MAX_IDENTIFIER_LENGTH = 63;

/** The names Portless serves the apps at, from portless.json, and the API's. */
const WEB_APP_NAME = "sugabots";
const API_NAME = "api.sugabots";

const LOCALHOST_SUFFIX = ".localhost";

const git = (cwd: string, ...args: string[]) =>
	execFileSync("git", args, { cwd, encoding: "utf8" }).trim();

const root = git(process.cwd(), "rev-parse", "--show-toplevel");
// `git worktree list` names the main checkout first.
const mainRoot = git(root, "worktree", "list", "--porcelain")
	.split("\n")[0]
	?.replace(/^worktree /, "");
if (!mainRoot) {
	fail("git listed no worktrees, so there is no main checkout to copy from.");
}
const mainEnvPath = join(mainRoot, ".env");
if (!existsSync(mainEnvPath)) {
	fail(`The main checkout has no .env at ${mainEnvPath}. Set that up first: this copies it.`);
}
const parentUrl =
	parseEnv(readFileSync(mainEnvPath, "utf8")).DATABASE_URL ??
	fail(`${mainEnvPath} has no DATABASE_URL, so there is no database to copy.`);
const parentName = databaseName(parentUrl);

const command = process.argv[2] ?? "create";
if (command === "prune") {
	await prune();
} else if (command === "create" || command === "reset") {
	await branch(command === "reset");
} else {
	fail(`Unknown command "${command}". Use no command, "reset" or "prune".`);
}

async function branch(reset: boolean) {
	if (root === mainRoot) {
		fail(
			"This is the main checkout, which uses the database the branches copy. Run this in a worktree made with `git worktree add`.",
		);
	}
	const branchName = git(root, "rev-parse", "--abbrev-ref", "HEAD");
	if (branchName === "HEAD") {
		fail("This worktree is not on a branch, so there is nothing to name its database after.");
	}
	// Without a running proxy, Portless guesses its port, and the URLs written would be wrong.
	const webAppUrl = portlessUrl(WEB_APP_NAME);
	if (!(await isListening(new URL(webAppUrl)))) {
		fail(
			"The Portless proxy is not running, so this branch's URLs are not known yet. Start it, by running `bun run dev` in the main checkout or `bunx portless proxy start --https`, then run this again.",
		);
	}
	const name = branchDatabaseName(branchName);
	const url = withDatabase(parentUrl, name);

	await withServer(async (client) => {
		if (reset) {
			await client.query(`drop database if exists ${identifier(name)} with (force)`);
		}
		if (await exists(client, name)) {
			console.log(`${name} exists; migrating it.`);
			return;
		}
		await copyParent(client, name);
		console.log(`Copied ${parentName} into ${name}.`);
	});
	const envPath = join(root, ".env");
	if (!existsSync(envPath)) {
		copyFileSync(mainEnvPath, envPath);
	}
	const env = readFileSync(envPath, "utf8");
	const values: Record<string, string> = {
		DATABASE_URL: url,
		PUBLIC_URL: webAppUrl,
		API_URL: portlessUrl(API_NAME),
	};
	// The API refuses a content origin another checkout's API answers at.
	const contentOrigin = parseEnv(env).CONTENT_ORIGIN;
	if (contentOrigin && new URL(contentOrigin).hostname.endsWith(LOCALHOST_SUFFIX)) {
		values.CONTENT_ORIGIN = portlessUrl(mainContentName());
	}
	writeFileSync(envPath, withEnvValues(env, values));

	// The worktree's own migrations, not this file's: this may be another checkout's copy.
	execFileSync("bun", ["run", "db:migrate"], {
		cwd: root,
		env: { ...process.env, DATABASE_URL: url },
		stdio: "inherit",
	});

	console.log(
		`\n${branchName} runs at ${values.PUBLIC_URL} on ${name}. Start it with \`bun run dev\`.`,
	);
}

async function prune() {
	const branches = git(root, "for-each-ref", "refs/heads", "--format=%(refname:short)").split("\n");
	const kept = new Set(branches.map(branchDatabaseName));
	await withServer(async (client) => {
		const { rows } = await client.query<{ name: string }>(
			"select datname as name from pg_database where starts_with(datname, $1)",
			[`${parentName}${BRANCH_INFIX}`],
		);
		const orphans = rows
			.map((row) => row.name)
			.filter((name) => !kept.has(name.replace(TEST_DATABASE_SUFFIX, "")));
		for (const name of orphans) {
			await client.query(`drop database ${identifier(name)} with (force)`);
			console.log(`Dropped ${name}.`);
		}
		if (orphans.length === 0) {
			console.log("Every branch database belongs to a branch.");
		}
	});
}

/**
 * Copies the parent database into `name`. Postgres refuses to copy a database
 * anybody is connected to, so connections to it are closed and refused for
 * the moment the copy takes: a dev server running on it reconnects after.
 */
async function copyParent(client: pg.Client, name: string) {
	const parent = identifier(parentName);
	const create = `create database ${identifier(name)} template ${parent}`;
	await client.query(`alter database ${parent} allow_connections false`);
	try {
		await client.query(
			"select pg_terminate_backend(pid) from pg_stat_activity where datname = $1 and pid <> pg_backend_pid()",
			[parentName],
		);
		try {
			await client.query("set file_copy_method = clone");
			await client.query(`${create} strategy file_copy`);
		} catch {
			// Postgres before 18 has no clone, and some filesystems can't share blocks.
			await client.query(create);
		}
	} finally {
		await client.query(`alter database ${parent} allow_connections true`);
	}
}

/** The branch's database: the parent's name, then the branch's, both safe to put unquoted in a URL. */
function branchDatabaseName(branchName: string): string {
	const suffix = branchName
		.toLowerCase()
		.replace(/[^a-z0-9]+/g, "_")
		.replace(/^_|_$/g, "");
	return `${parentName}${BRANCH_INFIX}${suffix}`.slice(0, MAX_IDENTIFIER_LENGTH);
}

/** The URL Portless serves `name` at from this worktree, branch prefix included. */
function portlessUrl(name: string): string {
	// `bunx` rather than `node_modules/.bin`, which is a .cmd shim on Windows.
	return execFileSync("bunx", ["portless", "get", name], { cwd: root, encoding: "utf8" }).trim();
}

function isListening(url: URL): Promise<boolean> {
	const port = Number(url.port) || 443;
	return new Promise((resolve) => {
		const socket = createConnection({ host: "localhost", port }, () => {
			socket.end();
			resolve(true);
		});
		socket.on("error", () => resolve(false));
	});
}

/** The content origin's Portless name, from the main checkout's .env: this one's may already have a prefix. */
function mainContentName(): string {
	const mainOrigin = parseEnv(readFileSync(mainEnvPath, "utf8")).CONTENT_ORIGIN;
	if (!mainOrigin) {
		fail(`Set CONTENT_ORIGIN in ${mainEnvPath} too, or in neither.`);
	}
	return new URL(mainOrigin).hostname.slice(0, -LOCALHOST_SUFFIX.length);
}

/**
 * `env` with each of `values` set: in place where the variable is already
 * assigned, even commented out, and appended where it is not. Other lines and
 * the file's line endings are kept.
 */
function withEnvValues(env: string, values: Record<string, string>): string {
	const newline = env.includes("\r\n") ? "\r\n" : "\n";
	const lines = env.split(/\r?\n/);
	for (const [key, value] of Object.entries(values)) {
		const assignment = `${key}=${value}`;
		const set = lines.findIndex((line) => line.startsWith(`${key}=`));
		const commented = lines.findIndex((line) => new RegExp(`^#\\s*${key}=`).test(line));
		const at = set >= 0 ? set : commented;
		if (at >= 0) {
			lines[at] = assignment;
		} else {
			lines.splice(lines.at(-1) === "" ? -1 : lines.length, 0, assignment);
		}
	}
	return lines.join(newline);
}

/** Runs `use` connected to the server's maintenance database, where databases are made and dropped. */
async function withServer(use: (client: pg.Client) => Promise<void>) {
	const client = new pg.Client({ connectionString: withDatabase(parentUrl, "postgres") });
	await client.connect();
	try {
		await use(client);
	} finally {
		await client.end();
	}
}

async function exists(client: pg.Client, name: string) {
	const { rowCount } = await client.query("select 1 from pg_database where datname = $1", [name]);
	return rowCount !== 0;
}

function databaseName(url: string): string {
	return new URL(url).pathname.replace(/^\//, "");
}

function withDatabase(url: string, name: string): string {
	const parsed = new URL(url);
	parsed.pathname = `/${name}`;
	return parsed.toString();
}

/** A database name quoted for SQL, which has no parameter form for an identifier. */
function identifier(name: string): string {
	return `"${name.replace(/"/g, '""')}"`;
}

function fail(message: string): never {
	console.error(message);
	process.exit(1);
}
