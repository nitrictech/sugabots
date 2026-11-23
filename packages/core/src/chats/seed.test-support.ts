import { randomUUID } from "node:crypto";
import type { SystemBotKey } from "@sugabots/contracts";
import { sql } from "drizzle-orm";
import { Effect } from "effect";
import type { Executor } from "../database/database.ts";
import {
	automationFeed,
	automationRun,
	chat,
	collaboration,
	projectChat,
	systemChat,
} from "../database/schema.ts";
import { defaultProjectIdOf } from "../workspaces/bots/bot.ts";

/**
 * A chat as fixtures write it straight into the database, as the
 * tests and the demo do: what every kind has, and what its kind's own table
 * holds. A run's and a collaboration's kind rows are their `run` and
 * `collaboration` rows, given whole but for the chat they name.
 */
type ChatSeed = {
	id?: string;
	workspaceId: string;
	title: string;
	createdAt?: Date;
	updatedAt?: Date;
} & KindSeed;

type KindSeed =
	| ({
			kind: "project_chat";
			archivedAt?: Date | null;
			resolvedAt?: Date | null;
			startedById: string;
	  } & (
			| { projectId: string }
			/** One of the bot's chats: in its default project. */
			| { botId: string }
	  ))
	| { kind: "automation_feed"; automationId: string }
	| {
			kind: "system_chat";
			botId: string;
			systemBotKey: SystemBotKey;
			servedChatId: string;
	  }
	| { kind: "run"; run: Omit<typeof automationRun.$inferInsert, "chatId" | "workspaceId"> }
	| {
			kind: "collaboration";
			collaboration: Omit<typeof collaboration.$inferInsert, "chatId">;
	  };

/**
 * Writes `seed` as one statement, its chat and its kind's row
 * together, so the chat is never without the kind row the database
 * requires of it by the end of the transaction.
 */
export function seedChat(db: Executor, seed: ChatSeed) {
	const id = seed.id ?? randomUUID();
	const shared = db.insert(chat).values({
		id,
		workspaceId: seed.workspaceId,
		kind: seed.kind,
		title: seed.title,
		createdAt: seed.createdAt,
		updatedAt: seed.updatedAt,
	});
	return db
		.execute(sql`with seeded as (${shared.getSQL()}) ${kindRowOf(db, id, seed).getSQL()}`)
		.pipe(Effect.as({ id }));
}

function kindRowOf(db: Executor, chatId: string, seed: ChatSeed) {
	const { workspaceId } = seed;
	switch (seed.kind) {
		case "project_chat":
			return db.insert(projectChat).values({
				chatId,
				workspaceId,
				projectId:
					"projectId" in seed ? seed.projectId : defaultProjectIdOf(sql`${seed.botId}::uuid`),
				resolvedAt: seed.resolvedAt,
				startedById: seed.startedById,
			});
		case "automation_feed":
			return db
				.insert(automationFeed)
				.values({ chatId, workspaceId, automationId: seed.automationId });
		case "system_chat":
			return db.insert(systemChat).values({
				chatId,
				workspaceId,
				botId: seed.botId,
				systemBotKey: seed.systemBotKey,
				servedChatId: seed.servedChatId,
			});
		case "run":
			return db.insert(automationRun).values({ ...seed.run, chatId, workspaceId });
		case "collaboration":
			return db.insert(collaboration).values({ ...seed.collaboration, chatId });
	}
}
