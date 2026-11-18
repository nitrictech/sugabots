import { sql } from "drizzle-orm";
import { DateTime, Effect } from "effect";
import { query, serviceOperations, transaction } from "../../database/database.ts";
import { botSummary, conversationSummary } from "../../database/schema.ts";
import { ConversationEvents } from "../conversation-events.ts";
import { ConversationEvent } from "../events.ts";

/**
 * The only writer of `summary` and `bot_summary`: each conversation's
 * latest summary, and each bot's, written by the Summariser.
 */
export interface Records {
	/**
	 * Replaces what the bot `botId` has been doing lately with `content`,
	 * written from conversation summaries the newest of which was written at
	 * `coversThrough`, unless the bot's summary already covers newer ones.
	 */
	readonly saveBotSummary: (summary: {
		botId: string;
		content: string;
		coversThrough: Date;
	}) => Effect.Effect<void>;
	/**
	 * Replaces the conversation's summary with one covering it up to
	 * `sourceMessageId`, and announces it in the conversation's workspace.
	 */
	readonly save: (summary: {
		workspaceId: string;
		conversationId: string;
		content: string;
		sourceMessageId: string;
	}) => Effect.Effect<void>;
}

/** The table's writes, which its module builds for itself. */
export const makeRecords = Effect.gen(function* () {
	const operation = yield* serviceOperations<Records>("Summaries");
	const { emit } = yield* ConversationEvents.Service;
	return {
		saveBotSummary: ({ botId, content, coversThrough }) =>
			operation(
				"saveBotSummary",
				Effect.gen(function* () {
					const updatedAt = yield* DateTime.nowAsDate;
					yield* query((db) =>
						db
							.insert(botSummary)
							.values({ botId, content, coversThrough })
							.onConflictDoUpdate({
								target: botSummary.botId,
								set: { content, coversThrough, updatedAt },
								// Two of the bot's conversations summarised together race to write it.
								setWhere: sql`${botSummary.coversThrough} <= excluded.covers_through`,
							}),
					);
				}),
			),

		save: (summary) =>
			operation(
				"save",
				transaction(
					Effect.gen(function* () {
						const updatedAt = yield* DateTime.nowAsDate;
						const written = {
							content: summary.content,
							sourceMessageId: summary.sourceMessageId,
						};
						yield* query((db) =>
							db
								.insert(conversationSummary)
								.values({ conversationId: summary.conversationId, ...written })
								.onConflictDoUpdate({
									target: conversationSummary.conversationId,
									set: { ...written, updatedAt },
								}),
						);
						yield* emit([
							ConversationEvent.ConversationSummarised({
								workspaceId: summary.workspaceId,
								conversationId: summary.conversationId,
							}),
						]);
					}),
				),
			),
	} satisfies Records;
});
