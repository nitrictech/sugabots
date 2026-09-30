import { DateTime, Effect } from "effect";
import { query, serviceOperations, transaction } from "../../database/database.ts";
import { threadSummary } from "../../database/schema.ts";
import { ConversationEvents } from "../conversation-events.ts";
import { ConversationEvent } from "../events.ts";

/** The only writer of `thread_summary`: each thread's latest summary, written by the Scribe. */
export interface Records {
	/**
	 * Replaces the thread's summary with one covering it up to
	 * `sourceMessageId`, and announces it in the thread's workspace.
	 */
	readonly save: (summary: {
		workspaceId: string;
		podId: string;
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
								podId: summary.podId,
								threadId: summary.threadId,
							}),
						]);
					}),
				),
			),
	} satisfies Records;
});
