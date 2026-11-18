import { sql } from "drizzle-orm";
import { DateTime, Effect } from "effect";
import { query, serviceOperations, transaction } from "../../database/database.ts";
import { agentSummary, threadSummary } from "../../database/schema.ts";
import { ConversationEvents } from "../conversation-events.ts";
import { ConversationEvent } from "../events.ts";

/**
 * The only writer of `thread_summary` and `agent_summary`: each thread's
 * latest summary, and each bot's, written by the Summariser.
 */
export interface Records {
	/**
	 * Replaces what the bot `agentId` has been doing lately with `content`,
	 * written from thread summaries the newest of which was written at
	 * `coversThrough`, unless the bot's summary already covers newer ones.
	 */
	readonly saveBotSummary: (summary: {
		agentId: string;
		content: string;
		coversThrough: Date;
	}) => Effect.Effect<void>;
	/**
	 * Replaces the thread's summary with one covering it up to
	 * `sourceMessageId`, and announces it in the thread's workspace.
	 */
	readonly save: (summary: {
		workspaceId: string;
		threadId: string;
		content: string;
		sourceMessageId: string;
	}) => Effect.Effect<void>;
}

/** The table's writes, which its module builds for itself. */
export const makeRecords = Effect.gen(function* () {
	const operation = yield* serviceOperations<Records>("Summaries");
	const { emit } = yield* ConversationEvents.Service;
	return {
		saveBotSummary: ({ agentId, content, coversThrough }) =>
			operation(
				"saveBotSummary",
				Effect.gen(function* () {
					const updatedAt = yield* DateTime.nowAsDate;
					yield* query((db) =>
						db
							.insert(agentSummary)
							.values({ agentId, content, coversThrough })
							.onConflictDoUpdate({
								target: agentSummary.agentId,
								set: { content, coversThrough, updatedAt },
								// Two of the bot's threads summarised together race to write it.
								setWhere: sql`${agentSummary.coversThrough} <= excluded.covers_through`,
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
								.insert(threadSummary)
								.values({ threadId: summary.threadId, ...written })
								.onConflictDoUpdate({
									target: threadSummary.threadId,
									set: { ...written, updatedAt },
								}),
						);
						yield* emit([
							ConversationEvent.ThreadSummarised({
								workspaceId: summary.workspaceId,
								threadId: summary.threadId,
							}),
						]);
					}),
				),
			),
	} satisfies Records;
});
