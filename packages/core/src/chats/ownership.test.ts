import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { shippedSourceFiles } from "../shipped-source.test-support.ts";

/**
 * Each chat table has one owner: only its store writes it. This
 * reads the source of the packages that can reach the database and lists
 * every Drizzle insert, update or delete of one of these tables made
 * anywhere else. Tests and their fixtures may write any table.
 */
const OWNERS: Record<string, readonly string[]> = {
	chat: ["core/src/chats/store/store.ts"],
	projectChat: ["core/src/chats/store/store.ts"],
	automationFeed: ["core/src/chats/store/store.ts"],
	systemChat: ["core/src/chats/store/store.ts"],
	chatParticipant: ["core/src/chats/store/store.ts"],
	// A turn writes its own reply while it runs; every other message is posted into a chat.
	message: ["core/src/chats/store/store.ts", "core/src/chats/turns/store.ts"],
	// A bot that stays silent on an optional turn reacts 👀 as its turn ends.
	messageReaction: ["core/src/chats/store/store.ts", "core/src/chats/turns/store.ts"],
	automation: ["core/src/chats/automations/store.ts"],
	automationTrigger: ["core/src/chats/automations/store.ts"],
	automationRun: ["core/src/chats/automations/store.ts"],
	chatCompaction: ["core/src/chats/compaction/store.ts"],
	readCursor: ["core/src/chats/store/store.ts"],
	// The turn authenticator raises a turn's execution number each time it
	// starts or resumes, which is how it authenticates a new execution.
	turn: ["core/src/chats/turns/store.ts", "core/src/authentication/turn.ts"],
	toolCall: ["core/src/chats/turns/tool-calls/store.ts"],
};

const write = new RegExp(`\\.(insert|update|delete)\\((${Object.keys(OWNERS).join("|")})\\)`, "g");

describe("chat table ownership", () => {
	it("leaves each table's writes to its owning store", () => {
		const strayWrites = shippedSourceFiles().flatMap(({ path, absolute }) =>
			[...readFileSync(absolute, "utf8").matchAll(write)]
				.filter((found) => !OWNERS[found[2] ?? ""]?.includes(path))
				.map((found) => `${path}: ${found[0]}`),
		);

		expect(strayWrites).toEqual([]);
	});
});
