import { and, asc, eq } from "drizzle-orm";
import { DateTime, Effect } from "effect";
import { type Database, type Executor, query, transaction } from "../../database/database.ts";
import type { DomainEvents } from "../../database/events/domain-events.ts";
import { agent, message, thread, threadSummary, user } from "../../database/schema.ts";
import type { UserMessage } from "../../user-message.ts";
import type { Lanes } from "../../workflows/lanes.ts";
import {
	findRunnableSystemAgent,
	SUMMARISE_SYSTEM_AGENT,
} from "../../workspaces/agents/system-agents.ts";
import { ConversationEvent } from "../events.ts";
import { participantColumns, toMessage } from "../threads/participants.ts";
import { loadPlacedParts } from "../threads/placed-parts.ts";
import { messageTextWithPlacedParts } from "../turns/context.ts";
import type { ModelAccounting } from "../turns/model.ts";
import type { TurnRepository } from "../turns/repository.ts";
import { Summary, type SummaryRequest, summaryLane } from "./summary.workflow.ts";

const SUMMARY_TRANSCRIPT_OVERLAP_MESSAGES = 10;

/**
 * Thread summaries, written by the `summarise` system agent.
 *
 * After an agent completes a turn, a summary is requested for the thread. The
 * system agent reads what was said since the last summary and rewrites it, and on
 * the first pass also titles the thread. Its turns live in a child thread of
 * the one being summarised, so a person can read back what the system agent did
 * without it appearing in their conversation.
 */

/**
 * A summary that has nothing to do: its thread or source is gone, it is
 * already written, or the Scribe's turn may not run. `reason` is for the logs.
 */
export interface SummarySkipped {
	readonly _tag: "Skipped";
	readonly reason: string;
}

export interface TranscriptEntry {
	author: string;
	kind: "person" | "agent";
	content: string;
}

/** A requested summary with its turn opened and its input loaded. */
export interface PreparedSummary {
	readonly _tag: "Prepared";
	request: SummaryRequest;
	turnId: string;
	threadId: string;
	workspaceId: string;
	/** The last message this summary will cover. */
	sourceMessageId: string;
	threadTitle: string;
	model: string;
	previousContent?: string;
	/** New messages plus recent overlap with the previous summary, oldest first. */
	transcript: TranscriptEntry[];
}

export interface SummaryStore {
	/**
	 * Opens the Scribe's turn and loads the transcript, or says why there is
	 * nothing to do. A turn that opening ended stays ended, so skipping is a
	 * result rather than a failure that would roll the ending back.
	 */
	prepare(
		request: SummaryRequest,
	): Effect.Effect<PreparedSummary | SummarySkipped, never, Database>;
	complete(
		prepared: PreparedSummary,
		result: { content: string; title?: string },
		accounting: ModelAccounting,
	): Effect.Effect<void, never, Database>;
	/** Ends the Scribe's turn as failed; `userMessage` is recorded on it for people to read. */
	fail(prepared: PreparedSummary, userMessage: UserMessage): Effect.Effect<void, never, Database>;
}

/**
 * Requests a summary that covers the thread up to `sourceMessageId`. A request
 * already waiting for the thread is pointed at this newer message instead.
 */
export const queueSummary = (lanes: Lanes.Interface, request: SummaryRequest) =>
	lanes
		.admit({
			key: summaryLane(request),
			workflow: Summary,
			payload: request,
			whenBusy: "replace",
		})
		.pipe(Effect.asVoid);

export function summaryStore(
	emit: DomainEvents.Emit<ConversationEvent>,
	turns: Pick<TurnRepository, "openScribeTurn" | "completeScribeTurn" | "failScribeTurn">,
): SummaryStore {
	return {
		prepare: (request) =>
			// One transaction, so the system-agent thread and its turn are created
			// together or not at all.
			transaction(
				Effect.gen(function* (): Effect.fn.Return<
					PreparedSummary | SummarySkipped,
					never,
					Database
				> {
					const scope = yield* query((db) => loadSummarisedThread(db, request));
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
					const sourceIndex = transcriptRows.findIndex((row) => row.id === request.sourceMessageId);
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

					const systemAgentThreadId = yield* query((db) =>
						systemAgentThreadFor(db, scope, summariser.id),
					);
					const opened = yield* turns.openScribeTurn({
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

		complete: (prepared, result, accounting) =>
			transaction(
				Effect.gen(function* () {
					const now = yield* DateTime.nowAsDate;
					if (result.title) {
						yield* query((db) =>
							db
								.update(thread)
								.set({ title: result.title, updatedAt: now })
								.where(eq(thread.id, prepared.threadId)),
						);
						// The thread holding the summaries is named after this one, which
						// had no real title until the first summary gave it one.
						yield* query((db) =>
							db
								.update(thread)
								.set({ title: summariesTitle(result.title ?? ""), updatedAt: now })
								.where(
									and(
										eq(thread.parentThreadId, prepared.threadId),
										eq(thread.systemAgentKey, SUMMARISE_SYSTEM_AGENT),
									),
								),
						);
					}
					yield* query((db) =>
						db
							.insert(threadSummary)
							.values({
								threadId: prepared.threadId,
								content: result.content,
								sourceMessageId: prepared.sourceMessageId,
							})
							.onConflictDoUpdate({
								target: threadSummary.threadId,
								set: {
									content: result.content,
									sourceMessageId: prepared.sourceMessageId,
									updatedAt: now,
								},
							}),
					);
					yield* turns.completeScribeTurn(prepared.turnId, accounting);
					yield* emit([
						ConversationEvent.ThreadSummarised({
							workspaceId: prepared.workspaceId,
							threadId: prepared.threadId,
						}),
					]);
				}),
			),

		fail: (prepared, userMessage) => turns.failScribeTurn(prepared.turnId, userMessage),
	};
}

function skipped(reason: string): SummarySkipped {
	return { _tag: "Skipped", reason };
}

/** The thread being summarised, as much of it as preparing a summary needs. */
interface SummarisedThread {
	threadId: string;
	podId: string;
	workspaceId: string;
	threadTitle: string;
	initiatorUserId: string | null;
}

/** The thread, if it still exists with this host and this source message. */
const loadSummarisedThread = Effect.fn("SummaryStore.loadSummarisedThread")(function* (
	db: Executor,
	request: SummaryRequest,
) {
	const [row] = yield* db
		.select({
			threadId: thread.id,
			podId: thread.podId,
			workspaceId: thread.workspaceId,
			threadTitle: thread.title,
			initiatorUserId: thread.initiatorUserId,
		})
		.from(thread)
		// The agent in the payload is whoever's reply triggered this, not whoever
		// writes the summary: that is the pod's summarise system agent, found below.
		// It need not be the thread's host, since anyone may reply in a shared thread.
		.innerJoin(agent, eq(agent.id, request.agentId))
		.innerJoin(
			message,
			and(eq(message.id, request.sourceMessageId), eq(message.threadId, thread.id)),
		)
		.where(eq(thread.id, request.threadId))
		.limit(1);
	return row;
});

/** A thread's current summary, and the last message it covers. */
export const loadThreadSummary = Effect.fn("SummaryStore.loadThreadSummary")(function* (
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

const loadTranscript = Effect.fn("SummaryStore.loadTranscript")(function* (
	db: Executor,
	threadId: string,
) {
	const rows = yield* db
		.select({
			message,
			...participantColumns,
		})
		.from(message)
		.leftJoin(user, eq(user.id, message.authorUserId))
		.leftJoin(agent, eq(agent.id, message.authorAgentId))
		.where(and(eq(message.threadId, threadId), eq(message.status, "complete")))
		.orderBy(asc(message.createdAt), asc(message.id));
	const placed = yield* loadPlacedParts(
		db,
		rows.map(({ message: row }) => row.id),
	);
	return rows.map(({ message: row, ...author }) => {
		const hydrated = toMessage(row, author, placed(row.id));
		const content = messageTextWithPlacedParts(hydrated);
		const authorName =
			hydrated.author.kind === "routine_trigger"
				? hydrated.author.routineName
				: hydrated.author.name;
		return {
			id: row.id,
			entry: content
				? {
						author: authorName,
						kind: hydrated.author.kind === "person" ? ("person" as const) : ("agent" as const),
						content,
					}
				: undefined,
		};
	});
});

/** What the thread holding a thread's summaries is called. */
function summariesTitle(threadTitle: string): string {
	return `Summaries of ${threadTitle}`;
}

/**
 * The system agent's own thread under the one being summarised: one per system agent per
 * thread, created on first use.
 */
const systemAgentThreadFor = Effect.fn("SummaryStore.systemAgentThreadFor")(function* (
	db: Executor,
	scope: SummarisedThread,
	summariserId: string,
) {
	const [created] = yield* db
		.insert(thread)
		.values({
			workspaceId: scope.workspaceId,
			// The summaries stay in the pod whose conversation they are about,
			// even though the Scribe hosting them belongs to the workspace.
			podId: scope.podId,
			hostAgentId: summariserId,
			chatId: null,
			type: "system_agent",
			title: summariesTitle(scope.threadTitle),
			systemAgentKey: SUMMARISE_SYSTEM_AGENT,
			parentThreadId: scope.threadId,
			initiatorUserId: scope.initiatorUserId,
		})
		.onConflictDoNothing({ target: [thread.parentThreadId, thread.systemAgentKey] })
		.returning({ id: thread.id });
	if (created) {
		return created.id;
	}
	const [existing] = yield* db
		.select({ id: thread.id })
		.from(thread)
		.where(
			and(
				eq(thread.parentThreadId, scope.threadId),
				eq(thread.systemAgentKey, SUMMARISE_SYSTEM_AGENT),
			),
		)
		.limit(1);
	if (!existing) {
		return yield* Effect.die(
			new Error("Preparing a thread summary returned no system-agent thread"),
		);
	}
	return existing.id;
});
