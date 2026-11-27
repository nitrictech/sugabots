import { DateTime, Effect } from "effect";
import { query, serviceOperations, transaction } from "../../database/database.ts";
import { chatCompaction } from "../../database/schema.ts";
import { ChatEvents } from "../chat-events.ts";
import { ChatEvent } from "../events.ts";

/**
 * The only writer of `compaction`: what each chat's bots read in
 * place of its older messages, written by the Compaction bot.
 */
interface CompactionStore {
	/**
	 * Replaces the chat's compaction, so its bots read `condensed` and then
	 * every message from `keptFrom` on, and announces it in the chat's workspace.
	 */
	readonly save: (compaction: {
		workspaceId: string;
		chatId: string;
		condensed: string;
		historyStartsAt: Date;
		keptFrom: Date;
	}) => Effect.Effect<void>;
}

/** The table's writes, which its module builds for itself. */
export const makeCompactionStore = Effect.gen(function* () {
	const operation = yield* serviceOperations<CompactionStore>("Compactions");
	const { emit } = yield* ChatEvents.Service;
	return {
		save: (compaction) =>
			operation(
				"save",
				transaction(
					Effect.gen(function* () {
						const updatedAt = yield* DateTime.nowAsDate;
						const written = {
							condensed: compaction.condensed,
							historyStartsAt: compaction.historyStartsAt,
							keptFrom: compaction.keptFrom,
						};
						yield* query((db) =>
							db
								.insert(chatCompaction)
								.values({ chatId: compaction.chatId, ...written })
								.onConflictDoUpdate({
									target: chatCompaction.chatId,
									set: { ...written, updatedAt },
								}),
						);
						yield* emit([
							ChatEvent.ChatCompacted({
								workspaceId: compaction.workspaceId,
								chatId: compaction.chatId,
							}),
						]);
					}),
				),
			),
	} satisfies CompactionStore;
});
