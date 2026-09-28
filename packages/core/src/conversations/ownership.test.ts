import { readdirSync, readFileSync } from "node:fs";
import { join, relative } from "node:path";
import { describe, expect, it } from "vitest";

/**
 * Each conversation table has one owner: only its repository writes it. This
 * reads the source of the packages that can reach the database and lists
 * every Drizzle insert, update or delete of one of these tables made
 * anywhere else. Tests and their fixtures may write any table.
 */
const OWNERS: Record<string, readonly string[]> = {
	thread: ["core/src/conversations/threads/repository.ts"],
	threadParticipant: ["core/src/conversations/threads/repository.ts"],
	chat: ["core/src/conversations/threads/repository.ts"],
	// A turn writes its own reply while it runs; every other message is posted into a thread.
	message: [
		"core/src/conversations/threads/repository.ts",
		"core/src/conversations/turns/repository.ts",
	],
	collaboration: ["core/src/conversations/tools/collaborate/repository.ts"],
	routine: ["core/src/conversations/routines/repository.ts"],
	routineExecution: ["core/src/conversations/routines/repository.ts"],
	threadSummary: ["core/src/conversations/summaries/repository.ts"],
	threadCompaction: ["core/src/conversations/compaction/repository.ts"],
	turn: ["core/src/conversations/turns/repository.ts"],
	toolCall: ["core/src/conversations/tools/calls/repository.ts"],
};

const packages = join(import.meta.dirname, "../../..");
const write = new RegExp(`\\.(insert|update|delete)\\((${Object.keys(OWNERS).join("|")})\\)`, "g");

describe("conversation table ownership", () => {
	it("leaves each table's writes to its owning repository", () => {
		const strayWrites = ["core/src", "server/src"]
			.flatMap((root) => sourceFiles(join(packages, root)))
			.flatMap((file) => {
				const path = relative(packages, file);
				return [...readFileSync(file, "utf8").matchAll(write)]
					.filter((found) => !OWNERS[found[2] ?? ""]?.includes(path))
					.map((found) => `${path}: ${found[0]}`);
			});

		expect(strayWrites).toEqual([]);
	});
});

/** The TypeScript files under `directory` that ship, leaving out tests and their fixtures. */
function sourceFiles(directory: string): string[] {
	return readdirSync(directory, { recursive: true, encoding: "utf8" })
		.filter(
			(name) =>
				name.endsWith(".ts") &&
				!name.endsWith(".test.ts") &&
				!name.endsWith(".test-support.ts") &&
				!name.endsWith("testing.ts") &&
				!name.split("/").includes("node_modules"),
		)
		.map((name) => join(directory, name));
}
