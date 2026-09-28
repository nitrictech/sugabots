import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { shippedSourceFiles } from "./shipped-source.test-support.ts";

/**
 * Time comes from Effect's `Clock` (through `DateTime`), and ids from `Ids`,
 * so a test can control both. This reads the source of core and the server
 * and lists every direct read of the clock or of a random id outside the
 * files below. Tests and their fixtures may do either.
 */
const ALLOWED: Record<string, string> = {
	// Drizzle stamps `updatedAt` from this callback on every update it builds.
	"core/src/database/sql.ts": "new Date(",
	// The in-memory event store is plain promise code, and its clock is an option.
	"core/src/database/events/store.ts": "new Date(",
	// Parses a cursor's timestamp; reads no clock.
	"core/src/conversations/cursor.ts": "new Date(",
};

const direct = /new Date\(|Date\.now\(|randomUUID\(/g;

describe("time and ids", () => {
	it("reads them only through Clock and Ids", () => {
		const strayReads = shippedSourceFiles().flatMap(({ path, absolute }) =>
			[...readFileSync(absolute, "utf8").matchAll(direct)]
				.filter((found) => ALLOWED[path] !== found[0])
				.map((found) => `${path}: ${found[0]}`),
		);

		expect(strayReads).toEqual([]);
	});
});
