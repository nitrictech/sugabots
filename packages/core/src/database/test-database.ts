/**
 * Which database the tests are allowed to write to.
 *
 * The store tests are about what the SQL does — joins, constraints, cascades,
 * what a transaction rolls back — so they run against a real Postgres and
 * leave rows behind. That is fine in a database kept for them and not fine in
 * the one a dev server is using, where the rows pile up in the sidebar and
 * every test run queues jobs the running workers try to claim.
 *
 * So there is no falling back to `DATABASE_URL`. A test database is named, or
 * one is derived by suffixing the development database's name, and using the
 * development database itself is refused rather than done quietly.
 */

export class DevelopmentDatabaseRefused extends Error {
	constructor(url: string) {
		super(
			`The tests were pointed at the development database (${redact(url)}). They write rows and queue jobs, so they need one of their own: set TEST_DATABASE_URL, or leave it unset and a "_test" database is used.`,
		);
		this.name = "DevelopmentDatabaseRefused";
	}
}

/** The suffix a derived test database's name gets. */
const SUFFIX = "_test";

/**
 * The database the tests run against, or `undefined` when none is configured
 * and none can be derived — the store tests skip themselves in that case.
 */
export function testDatabaseUrl(env: {
	DATABASE_URL?: string | undefined;
	TEST_DATABASE_URL?: string | undefined;
}): string | undefined {
	const named = env.TEST_DATABASE_URL?.trim();
	if (named) {
		if (env.DATABASE_URL && sameDatabase(named, env.DATABASE_URL)) {
			throw new DevelopmentDatabaseRefused(named);
		}
		return named;
	}
	const development = env.DATABASE_URL?.trim();
	return development ? withSuffix(development) : undefined;
}

/** The same URL with `_test` on the end of the database name. */
function withSuffix(url: string): string {
	const parsed = new URL(url);
	// The path is "/name"; an empty one means the server's default database,
	// which is not something to suffix.
	const name = parsed.pathname.replace(/^\//, "");
	if (!name) {
		throw new DevelopmentDatabaseRefused(url);
	}
	parsed.pathname = `/${name}${SUFFIX}`;
	return parsed.toString();
}

/** Whether two URLs name the same database on the same server. */
function sameDatabase(one: string, other: string): boolean {
	const [a, b] = [new URL(one), new URL(other)];
	return a.host === b.host && a.pathname === b.pathname;
}

/** A URL without its password, for a message somebody will paste into an issue. */
function redact(url: string): string {
	const parsed = new URL(url);
	if (parsed.password) {
		parsed.password = "***";
	}
	return parsed.toString();
}
