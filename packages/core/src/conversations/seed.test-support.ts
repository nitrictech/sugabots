import { randomUUID } from "node:crypto";
import type { SystemBotKey } from "@sugabots/contracts";
import { sql } from "drizzle-orm";
import { Effect } from "effect";
import type { Executor } from "../database/database.ts";
import {
	automationFeed,
	automationRun,
	collaboration,
	conversation,
	directMessage,
	project,
	projectThread,
	systemConversation,
} from "../database/schema.ts";

/**
 * A conversation as fixtures write it straight into the database, as the
 * tests and the demo do: what every kind has, and what its kind's own table
 * holds. A run's and a collaboration's kind rows are their `run` and
 * `collaboration` rows, given whole but for the conversation they name.
 */
type ConversationSeed = {
	id?: string;
	workspaceId: string;
	title: string;
	createdAt?: Date;
	updatedAt?: Date;
} & KindSeed;

type KindSeed =
	| ({
			kind: "project_thread";
			archivedAt?: Date | null;
			doneAt?: Date | null;
			startedById?: string | null;
	  } & (
			| { projectId: string }
			/** One of the bot's threads: in its default project. */
			| { botId: string }
	  ))
	| { kind: "direct_message"; directKey: string; startedById?: string | null }
	| { kind: "automation_feed"; automationId: string }
	| {
			kind: "system";
			botId: string;
			systemBotKey: SystemBotKey;
			servedConversationId: string;
	  }
	| { kind: "run"; run: Omit<typeof automationRun.$inferInsert, "conversationId" | "workspaceId"> }
	| {
			kind: "collaboration";
			collaboration: Omit<typeof collaboration.$inferInsert, "conversationId">;
	  };

/**
 * Writes `seed` as one statement, its conversation and its kind's row
 * together, so the conversation is never without the kind row the database
 * requires of it by the end of the transaction.
 */
export function seedConversation(db: Executor, seed: ConversationSeed) {
	const id = seed.id ?? randomUUID();
	const shared = db.insert(conversation).values({
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

function kindRowOf(db: Executor, conversationId: string, seed: ConversationSeed) {
	const { workspaceId } = seed;
	switch (seed.kind) {
		case "project_thread":
			return db.insert(projectThread).values({
				conversationId,
				workspaceId,
				projectId:
					"projectId" in seed
						? seed.projectId
						: sql`(select ${project.id} from ${project} where ${project.defaultOfBotId} = ${seed.botId})`,
				archivedAt: seed.archivedAt,
				doneAt: seed.doneAt,
				startedById: seed.startedById,
			});
		case "direct_message":
			return db.insert(directMessage).values({
				conversationId,
				workspaceId,
				directKey: seed.directKey,
				startedById: seed.startedById,
			});
		case "automation_feed":
			return db
				.insert(automationFeed)
				.values({ conversationId, workspaceId, automationId: seed.automationId });
		case "system":
			return db.insert(systemConversation).values({
				conversationId,
				workspaceId,
				botId: seed.botId,
				systemBotKey: seed.systemBotKey,
				servedConversationId: seed.servedConversationId,
			});
		case "run":
			return db.insert(automationRun).values({ ...seed.run, conversationId, workspaceId });
		case "collaboration":
			return db.insert(collaboration).values({ ...seed.collaboration, conversationId });
	}
}
