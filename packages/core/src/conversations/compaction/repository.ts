import { DateTime, Effect } from "effect";
import { query, serviceOperations, transaction } from "../../database/database.ts";
import { threadCompaction } from "../../database/schema.ts";
import { ConversationEvents } from "../conversation-events.ts";
import { ConversationEvent } from "../events.ts";

/**
 * The only writer of `thread_compaction`: what each thread's bots read in
 * place of its older messages, written by the Compaction agent.
 */
export interface Records {
	/**
	 * Replaces the thread's compaction, so its bots read `summary` and then
	 * every message from `keptFrom` on, and announces it in the thread's workspace.
	 */
	readonly save: (compaction: {
		workspaceId: string;
		podId: string;
		threadId: string;
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
								.insert(threadCompaction)
								.values({ threadId: compaction.threadId, ...written })
								.onConflictDoUpdate({
									target: threadCompaction.threadId,
									set: { ...written, updatedAt },
								}),
						);
						yield* emit([
							ConversationEvent.ThreadCompacted({
								workspaceId: compaction.workspaceId,
								podId: compaction.podId,
								threadId: compaction.threadId,
							}),
						]);
					}),
				),
			),
	} satisfies Records;
});
