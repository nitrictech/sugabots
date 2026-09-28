import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { shippedSourceFiles } from "./shipped-source.test-support.ts";

/**
 * Code reads the time from Effect's `Clock` (through `DateTime`), so a test
 * can control it; the database stamps rows' `createdAt` and `updatedAt`
 * itself. The database mints row ids, and the ids code mints come from `Ids`.
 * This reads the source of core and the server and lists every direct read of
 * the clock or of a random id outside the files below. Tests and their
 * fixtures may do either.
 */
const ALLOWED: Record<string, string> = {
	// The in-memory event store is plain promise code, and its clock is an option.
	"core/src/database/events/store.ts": "new Date(",
	// Parses a cursor's timestamp; reads no clock.
	"core/src/conversations/cursor.ts": "new Date(",
};

const direct = /new Date\(|Date\.now\(|randomUUID\(/g;

describe("time and ids", () => {
	it("reads them in code only through Clock and Ids", () => {
		const strayReads = shippedSourceFiles().flatMap(({ path, absolute }) =>
			[...readFileSync(absolute, "utf8").matchAll(direct)]
				.filter((found) => ALLOWED[path] !== found[0])
				.map((found) => `${path}: ${found[0]}`),
		);

		expect(strayReads).toEqual([]);
	});
});
