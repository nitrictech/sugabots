import { DateTime, Effect } from "effect";
import { query, serviceOperations, transaction } from "../../database/database.ts";
import { conversationCompaction } from "../../database/schema.ts";
import { ConversationEvents } from "../conversation-events.ts";
import { ConversationEvent } from "../events.ts";

/**
 * The only writer of `compaction`: what each conversation's bots read in
 * place of its older messages, written by the Compaction bot.
 */
export interface Records {
	/**
	 * Replaces the conversation's compaction, so its bots read `summary` and then
	 * every message from `keptFrom` on, and announces it in the conversation's workspace.
	 */
	readonly save: (compaction: {
		workspaceId: string;
		conversationId: string;
		summary: string;
		historyStartsAt: Date;
		keptFrom: Date;
	}) => Effect.Effect<void>;
}

/** The table's writes, which its module builds for itself. */
export const makeRecords = Effect.gen(function* () {
	const operation = yield* serviceOperations<Records>("Compactions");
	const { emit } = yield* ConversationEvents.Service;
	return {
		save: (compaction) =>
			operation(
				"save",
				transaction(
					Effect.gen(function* () {
						const updatedAt = yield* DateTime.nowAsDate;
						const written = {
							summary: compaction.summary,
							historyStartsAt: compaction.historyStartsAt,
							keptFrom: compaction.keptFrom,
						};
						yield* query((db) =>
							db
								.insert(conversationCompaction)
								.values({ conversationId: compaction.conversationId, ...written })
								.onConflictDoUpdate({
									target: conversationCompaction.conversationId,
									set: { ...written, updatedAt },
								}),
						);
						yield* emit([
							ConversationEvent.ConversationCompacted({
								workspaceId: compaction.workspaceId,
								conversationId: compaction.conversationId,
							}),
						]);
					}),
				),
			),
	} satisfies Records;
});
