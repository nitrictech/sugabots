import { describe, expect, it } from "vitest";
import { DevelopmentDatabaseRefused, testDatabaseUrl } from "./test-database.ts";

/**
 * Which database the tests write to, which is the one thing here that must not
 * be got wrong: the run empties it, and the store tests fill it with rows and
 * queue jobs a running dev server would try to claim.
 */

const development = "postgresql://sugabots:secret@localhost:5436/sugabots";

describe("choosing the tests' database", () => {
	it("uses the one that was named", () => {
		expect(
			testDatabaseUrl({
				DATABASE_URL: development,
				TEST_DATABASE_URL: "postgresql://sugabots:secret@localhost:5436/somewhere_else",
			}),
		).toBe("postgresql://sugabots:secret@localhost:5436/somewhere_else");
	});

	it("derives one from the development database when none was named", () => {
		expect(testDatabaseUrl({ DATABASE_URL: development })).toBe(
			"postgresql://sugabots:secret@localhost:5436/sugabots_test",
		);
	});

	it("refuses the development database, however it was named", () => {
		// The failure this exists for: the tests filled the database a dev server
		// was using, and nothing said so until somebody opened the sidebar.
		expect(() =>
			testDatabaseUrl({ DATABASE_URL: development, TEST_DATABASE_URL: development }),
		).toThrow(DevelopmentDatabaseRefused);
	});

	it("keeps the password out of what it says when it refuses", () => {
		expect(() =>
			testDatabaseUrl({ DATABASE_URL: development, TEST_DATABASE_URL: development }),
		).toThrow(/\*\*\*/);
		expect(() =>
			testDatabaseUrl({ DATABASE_URL: development, TEST_DATABASE_URL: development }),
		).not.toThrow(/secret/);
	});

	it("has nothing to offer when no database is configured at all", () => {
		// The store tests skip themselves rather than failing, as they always have.
		expect(testDatabaseUrl({})).toBeUndefined();
	});
});
