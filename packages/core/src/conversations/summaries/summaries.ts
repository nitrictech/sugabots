export * as Summaries from "./summaries.ts";

import { eq } from "drizzle-orm";
import { Context, Effect, Layer } from "effect";
import {
	type Database,
	type Executor,
	query,
	serviceOperations,
	transaction,
} from "../../database/database.ts";
import { threadSummary } from "../../database/schema.ts";
import {
	findRunnableSystemAgent,
	SUMMARISE_SYSTEM_AGENT,
} from "../../workspaces/agents/system-agents.ts";
import { ThreadRepository } from "../threads/repository.ts";
import {
	loadSystemAgentScope,
	loadTranscript,
	type TranscriptEntry,
} from "../threads/system-agent-threads.ts";
import type { ModelAccounting } from "../turns/model.ts";
import { TurnRepository } from "../turns/repository.ts";
import { SummaryRepository } from "./repository.ts";
import type { SummaryRequest } from "./summary.workflow.ts";

/**
 * Thread summaries, written by the `summarise` system agent.
 *
 * After an agent completes a turn, a summary is requested for the thread. The
 * system agent reads what was said since the last summary and rewrites it, and on
 * the first pass also titles the thread. Its turns live in a child thread of
 * the one being summarised, so a person can read back what the system agent did
 * without it appearing in their conversation.
 */
export interface Interface {
	/**
	 * Opens the Scribe's turn and loads the transcript, or says why there is
	 * nothing to do. A turn that opening ended stays ended, so skipping is a
	 * result rather than a failure that would roll the ending back.
	 */
	readonly prepare: (request: SummaryRequest) => Effect.Effect<PreparedSummary | SummarySkipped>;
	/**
	 * Records the summary, and titles the thread on its first, completing the
	 * Scribe's turn. A failed one is recorded on the turn (`TurnRepository.failSystemAgentTurn`).
	 */
	readonly complete: (
		prepared: PreparedSummary,
		result: { content: string; title?: string },
		accounting: ModelAccounting,
	) => Effect.Effect<void>;
}

export class Service extends Context.Service<Service, Interface>()("@sugabots/core/Summaries") {}

export const make = Effect.gen(function* () {
	const operation = yield* serviceOperations<Interface>("Summaries");
	const turns = yield* TurnRepository.Service;
	const threads = yield* ThreadRepository.Service;
	const summaries = yield* SummaryRepository.Service;
	return Service.of({
		prepare: (request) =>
			operation(
				"prepare",
				// One transaction, so the system-agent thread and its turn are created
				// together or not at all.
				transaction(
					Effect.gen(function* (): Effect.fn.Return<
						PreparedSummary | SummarySkipped,
						never,
						Database
					> {
						const scope = yield* query((db) => loadSystemAgentScope(db, request));
						if (!scope) {
							return skipped("The thread, the agent that triggered it, or its message is gone");
						}
						const summariser = yield* query((db) =>
							findRunnableSystemAgent(db, scope.workspaceId, SUMMARISE_SYSTEM_AGENT),
						);
						if (!summariser) return skipped("This workspace has chosen no model for the Scribe");

						// One query at a time: inside a transaction the executor is a single
						// connection, and queries sent concurrently down one are not run concurrently
						// anyway. The driver queues them, and warns that it is about to stop accepting
						// them at all.
						const previous = yield* query((db) => loadThreadSummary(db, scope.threadId));
						const transcriptRows = yield* query((db) => loadTranscript(db, scope.threadId));
						const sourceIndex = transcriptRows.findIndex(
							(row) => row.id === request.sourceMessageId,
						);
						if (sourceIndex === -1) {
							return yield* Effect.die(
								new Error("Thread summary source message disappeared during preparation"),
							);
						}
						const previousSourceIndex = previous
							? transcriptRows.findIndex((row) => row.id === previous.sourceMessageId)
							: -1;
						if (previousSourceIndex >= sourceIndex) {
							return skipped("The thread is already summarised to this message");
						}

						const systemAgentThreadId = yield* threads.openSystemAgentThread({
							served: {
								id: scope.threadId,
								workspaceId: scope.workspaceId,
								podId: scope.podId,
								initiatorUserId: scope.initiatorUserId,
							},
							systemAgentId: summariser.id,
							systemAgentKey: SUMMARISE_SYSTEM_AGENT,
							title: summariesTitle(scope.threadTitle),
						});
						const opened = yield* turns.openSystemAgentTurn({
							threadId: systemAgentThreadId,
							agentId: summariser.id,
							triggerMessageId: request.sourceMessageId,
							model: summariser.model,
						});
						if (opened._tag === "NotRunnable") return skipped(opened.reason);

						return {
							_tag: "Prepared",
							request,
							turnId: opened.turnId,
							threadId: scope.threadId,
							workspaceId: scope.workspaceId,
							podId: scope.podId,
							sourceMessageId: request.sourceMessageId,
							threadTitle: scope.threadTitle,
							model: summariser.model,
							previousContent: previous?.content,
							transcript: transcriptRows
								.slice(
									Math.max(0, previousSourceIndex + 1 - SUMMARY_TRANSCRIPT_OVERLAP_MESSAGES),
									sourceIndex + 1,
								)
								.flatMap(({ entry }) => (entry ? [entry] : [])),
						};
					}),
				),
			),

		complete: (prepared, result, accounting) =>
			operation(
				"complete",
				transaction(
					Effect.gen(function* () {
						if (result.title) {
							yield* threads.retitle(prepared.threadId, result.title);
							// The thread holding the summaries is named after this one, which
							// had no real title until the first summary gave it one.
							yield* threads.retitleSystemAgentThread({
								servedThreadId: prepared.threadId,
								systemAgentKey: SUMMARISE_SYSTEM_AGENT,
								title: summariesTitle(result.title),
							});
						}
						yield* summaries.save({
							workspaceId: prepared.workspaceId,
							podId: prepared.podId,
							threadId: prepared.threadId,
							content: result.content,
							sourceMessageId: prepared.sourceMessageId,
						});
						yield* turns.completeSystemAgentTurn(prepared.turnId, accounting);
					}),
				),
			),
	});
});

export const layerNoDeps = Layer.effect(Service, make);

export const layer = layerNoDeps.pipe(
	Layer.provide([TurnRepository.layer, ThreadRepository.layer, SummaryRepository.layer]),
);

const SUMMARY_TRANSCRIPT_OVERLAP_MESSAGES = 10;

/**
 * A summary that has nothing to do: its thread or source is gone, it is
 * already written, or the Scribe's turn may not run. `reason` is for the logs.
 */
interface SummarySkipped {
	readonly _tag: "Skipped";
	readonly reason: string;
}

/** A requested summary with its turn opened and its input loaded. */
export interface PreparedSummary {
	readonly _tag: "Prepared";
	request: SummaryRequest;
	turnId: string;
	threadId: string;
	workspaceId: string;
	podId: string;
	/** The last message this summary will cover. */
	sourceMessageId: string;
	threadTitle: string;
	model: string;
	previousContent?: string;
	/** New messages plus recent overlap with the previous summary, oldest first. */
	transcript: TranscriptEntry[];
}

function skipped(reason: string): SummarySkipped {
	return { _tag: "Skipped", reason };
}

/** A thread's current summary, and the last message it covers. */
const loadThreadSummary = Effect.fn("Summaries.loadThreadSummary")(function* (
	db: Executor,
	threadId: string,
) {
	const [row] = yield* db
		.select({ content: threadSummary.content, sourceMessageId: threadSummary.sourceMessageId })
		.from(threadSummary)
		.where(eq(threadSummary.threadId, threadId))
		.limit(1);
	return row;
});

/** What the thread holding a thread's summaries is called. */
function summariesTitle(threadTitle: string): string {
	return `Summaries of ${threadTitle}`;
}
