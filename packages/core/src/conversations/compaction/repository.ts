export * as CompactionRepository from "./repository.ts";

import { Context, DateTime, Effect, Layer } from "effect";
import { query, serviceOperations, transaction } from "../../database/database.ts";
import { threadCompaction } from "../../database/schema.ts";
import { ConversationEvents } from "../conversation-events.ts";
import { ConversationEvent } from "../events.ts";

/**
 * The only writer of `thread_compaction`: what each thread's bots read in
 * place of its older messages, written by the Compaction agent.
 */
export interface Interface {
	/**
	 * Replaces the thread's compaction, so its bots read `summary` and then
	 * every message from `keptFrom` on, and announces it in the thread's workspace.
	 */
	readonly save: (compaction: {
		workspaceId: string;
		threadId: string;
		summary: string;
		historyStartsAt: Date;
		keptFrom: Date;
	}) => Effect.Effect<void>;
}

export class Service extends Context.Service<Service, Interface>()(
	"@sugabots/core/CompactionRepository",
) {}

export const make = Effect.gen(function* () {
	const operation = yield* serviceOperations<Interface>("CompactionRepository");
	const { emit } = yield* ConversationEvents.Service;
	return Service.of({
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
								threadId: compaction.threadId,
							}),
						]);
					}),
				),
			),
	});
});

export const layer = Layer.effect(Service, make);
