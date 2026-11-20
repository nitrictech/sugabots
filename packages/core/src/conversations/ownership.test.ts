import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { shippedSourceFiles } from "../shipped-source.test-support.ts";

/**
 * Each conversation table has one owner: only its repository writes it. This
 * reads the source of the packages that can reach the database and lists
 * every Drizzle insert, update or delete of one of these tables made
 * anywhere else. Tests and their fixtures may write any table.
 */
const OWNERS: Record<string, readonly string[]> = {
	conversation: ["core/src/conversations/repository/repository.ts"],
	thread: ["core/src/conversations/repository/repository.ts"],
	projectThread: ["core/src/conversations/repository/repository.ts"],
	automationFeed: ["core/src/conversations/repository/repository.ts"],
	systemConversation: ["core/src/conversations/repository/repository.ts"],
	conversationParticipant: ["core/src/conversations/repository/repository.ts"],
	// A turn writes its own reply while it runs; every other message is posted into a conversation.
	message: [
		"core/src/conversations/repository/repository.ts",
		"core/src/conversations/turns/repository.ts",
	],
	// A bot that stays silent on an optional turn reacts 👀 as its turn ends.
	messageReaction: [
		"core/src/conversations/repository/repository.ts",
		"core/src/conversations/turns/repository.ts",
	],
	collaboration: ["core/src/conversations/tools/collaborate/repository.ts"],
	automation: ["core/src/conversations/automations/repository.ts"],
	automationTrigger: ["core/src/conversations/automations/repository.ts"],
	automationRun: ["core/src/conversations/automations/repository.ts"],
	conversationSummary: ["core/src/conversations/summaries/repository.ts"],
	botSummary: ["core/src/conversations/summaries/repository.ts"],
	conversationCompaction: ["core/src/conversations/compaction/repository.ts"],
	conversationRead: ["core/src/conversations/repository/repository.ts"],
	turn: ["core/src/conversations/turns/repository.ts"],
	toolCall: ["core/src/conversations/turns/tool-calls/repository.ts"],
};

const write = new RegExp(`\\.(insert|update|delete)\\((${Object.keys(OWNERS).join("|")})\\)`, "g");

describe("conversation table ownership", () => {
	it("leaves each table's writes to its owning repository", () => {
		const strayWrites = shippedSourceFiles().flatMap(({ path, absolute }) =>
			[...readFileSync(absolute, "utf8").matchAll(write)]
				.filter((found) => !OWNERS[found[2] ?? ""]?.includes(path))
				.map((found) => `${path}: ${found[0]}`),
		);

		expect(strayWrites).toEqual([]);
	});
});
