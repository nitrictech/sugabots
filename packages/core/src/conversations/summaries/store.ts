import { streamEvent, threadChannel, workspaceChannel } from "@sugabots/contracts";
import { and, asc, eq } from "drizzle-orm";
import { Effect } from "effect";
import { type Database, type Executor, query, transaction } from "../../database/database.ts";
import type { PublishEvents } from "../../database/events/publish.ts";
import { agent, message, thread, threadSummary, turn, user } from "../../database/schema.ts";
import {
	findRunnableSystemAgent,
	SUMMARISE_SYSTEM_AGENT,
} from "../../workspaces/agents/system-agents.ts";
import {
	type ClaimedJob,
	cancelJob,
	claimNextJob,
	completeJob,
	enqueueJob,
	JobNotRunnable,
	requeueInterruptedJobs,
	retryUnlessSuperseded,
} from "../jobs/queue.ts";
import { participantColumns, toMessage } from "../threads/participants.ts";
import { loadPlacedParts } from "../threads/placed-parts.ts";
import { messageTextWithPlacedParts } from "../turns/context.ts";
import type { ModelAccounting } from "../turns/model.ts";

const SUMMARY_TRANSCRIPT_OVERLAP_MESSAGES = 10;

/**
 * Thread summaries, written by the `summarise` system agent.
 *
 * After an agent completes a turn, a summary job is queued for the thread. The
 * system agent reads what was said since the last summary and rewrites it, and on
 * the first pass also titles the thread. Its turns live in a child thread of
 * the one being summarised, so a person can read back what the system agent did
 * without it appearing in their conversation.
 */

export type ClaimedSummary = ClaimedJob<"thread_summary">;

export interface TranscriptEntry {
	author: string;
	kind: "person" | "agent";
	content: string;
}

/** A claimed summary with its turn opened and its input loaded. */
export interface PreparedSummary {
	job: ClaimedSummary;
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
	requeueInterrupted(): Effect.Effect<void, never, Database>;
	claimNext(): Effect.Effect<ClaimedSummary | undefined, never, Database>;
	/**
	 * Records that preparing failed. Retries unless a newer summary for the
	 * same thread is already queued, which supersedes this one.
	 */
	releaseFailedClaim(claimed: ClaimedSummary, error: string): Effect.Effect<void, never, Database>;
	/**
	 * Opens the system agent's turn and loads the transcript. Fails when the thread
	 * is gone, has no summariser, or is already summarised this far.
	 */
	prepare(claimed: ClaimedSummary): Effect.Effect<PreparedSummary, JobNotRunnable, Database>;
	complete(
		prepared: PreparedSummary,
		result: { content: string; title?: string },
		accounting: ModelAccounting,
	): Effect.Effect<void, never, Database>;
	fail(prepared: PreparedSummary, error: string): Effect.Effect<void, never, Database>;
	/** Ends a claim that cannot run, recording why. */
	discard(
		claimed: Pick<ClaimedSummary, "id">,
		reason: string,
	): Effect.Effect<void, never, Database>;
}

/**
 * Queues a summary that covers the thread up to `sourceMessageId`. A summary
 * already queued for the thread is pointed at this newer message instead.
 */
export const queueSummary = (input: {
	threadId: string;
	agentId: string;
	sourceMessageId: string;
}): Effect.Effect<void, never, Database> =>
	enqueueJob({
		kind: "thread_summary",
		threadId: input.threadId,
		payload: { agentId: input.agentId, sourceMessageId: input.sourceMessageId },
		dedupeKey: `thread-summary:${input.threadId}`,
		ifAlreadyQueued: "replacePayload",
	});

export function summaryStore(publishEvents: PublishEvents): SummaryStore {
	return {
		requeueInterrupted: () => requeueInterruptedJobs("thread_summary"),

		claimNext: () => claimNextJob("thread_summary"),

		releaseFailedClaim: retryUnlessSuperseded,

		prepare: (claimed) =>
			// One transaction, so the system-agent thread and its turn are created
			// together or not at all.
			transaction(
				Effect.flatMap(
					query(async (db) => {
						const scope = await loadSummarisedThread(db, claimed);
						if (!scope) {
							return new JobNotRunnable({
								reason: "The thread, the agent that triggered it, or its message is gone",
							});
						}
						const summariser = await findRunnableSystemAgent(
							db,
							scope.workspaceId,
							SUMMARISE_SYSTEM_AGENT,
						);
						if (!summariser) {
							return new JobNotRunnable({
								reason: "This workspace has chosen no model for the Scribe",
							});
						}

						// One query at a time: inside a transaction the executor is a single
						// connection, and queries sent concurrently down one are not run concurrently
						// anyway. The driver queues them, and warns that it is about to stop accepting
						// them at all.
						const previous = await loadThreadSummary(db, scope.threadId);
						const transcriptRows = await loadTranscript(db, scope.threadId);
						const sourceIndex = transcriptRows.findIndex(
							(row) => row.id === claimed.payload.sourceMessageId,
						);
						if (sourceIndex === -1) {
							throw new Error("Thread summary source message disappeared during preparation");
						}
						const previousSourceIndex = previous
							? transcriptRows.findIndex((row) => row.id === previous.sourceMessageId)
							: -1;
						if (previousSourceIndex >= sourceIndex) {
							return new JobNotRunnable({
								reason: "The thread is already summarised to this message",
							});
						}

						const systemAgentThreadId = await systemAgentThreadFor(db, scope, summariser.id);
						const turnId = await openSystemAgentTurn(db, claimed, systemAgentThreadId, summariser);

						return {
							job: claimed,
							turnId,
							threadId: scope.threadId,
							workspaceId: scope.workspaceId,
							sourceMessageId: claimed.payload.sourceMessageId,
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
					(outcome) =>
						outcome instanceof JobNotRunnable ? Effect.fail(outcome) : Effect.succeed(outcome),
				),
			),

		complete: (prepared, result, accounting) =>
			transaction(
				Effect.gen(function* () {
					if (result.title) {
						yield* query((db) =>
							db
								.update(thread)
								.set({ title: result.title, updatedAt: new Date() })
								.where(eq(thread.id, prepared.threadId)),
						);
						// And the system-agent thread that holds these summaries, which was
						// named after the parent before the parent had a real title —
						// the first summary is what gives it one, so its own name was
						// always a sentence out of date.
						yield* query((db) =>
							db
								.update(thread)
								.set({ title: summariesTitle(result.title ?? ""), updatedAt: new Date() })
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
									updatedAt: new Date(),
								},
							}),
					);
					yield* query((db) =>
						db
							.update(turn)
							.set({
								status: "done",
								usage: accounting.usage,
								reportedCost:
									accounting.reportedCost === undefined ? null : String(accounting.reportedCost),
								contextTokens: accounting.contextTokens ?? null,
								contextCapacity: accounting.contextCapacity ?? null,
								finishedAt: new Date(),
							})
							.where(eq(turn.id, prepared.turnId)),
					);
					yield* completeJob(prepared.job.id);
					yield* publishEvents([
						{
							channel: workspaceChannel(prepared.workspaceId),
							event: streamEvent("thread.changed"),
						},
						{
							channel: threadChannel(prepared.threadId),
							event: streamEvent("thread.changed", { threadId: prepared.threadId }),
						},
					]);
				}),
			),

		fail: (prepared, error) =>
			transaction(
				Effect.andThen(
					query((db) =>
						db
							.update(turn)
							.set({ status: "failed", error, finishedAt: new Date() })
							.where(eq(turn.id, prepared.turnId)),
					),
					retryUnlessSuperseded(prepared.job, error),
				),
			),

		discard: (claimed, reason) => cancelJob(claimed.id, reason),
	};
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
async function loadSummarisedThread(
	db: Executor,
	claimed: ClaimedSummary,
): Promise<SummarisedThread | undefined> {
	const [row] = await db
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
		// Requiring it to be the thread's host meant a shared thread stopped being
		// summarised the moment anyone but the host replied.
		.innerJoin(agent, eq(agent.id, claimed.payload.agentId))
		.innerJoin(
			message,
			and(eq(message.id, claimed.payload.sourceMessageId), eq(message.threadId, thread.id)),
		)
		.where(eq(thread.id, claimed.threadId))
		.limit(1);
	return row;
}

/** A thread's current summary, and the last message it covers. */
export async function loadThreadSummary(db: Executor, threadId: string) {
	const [row] = await db
		.select({ content: threadSummary.content, sourceMessageId: threadSummary.sourceMessageId })
		.from(threadSummary)
		.where(eq(threadSummary.threadId, threadId))
		.limit(1);
	return row;
}

async function loadTranscript(db: Executor, threadId: string) {
	const rows = await db
		.select({
			message,
			...participantColumns,
		})
		.from(message)
		.leftJoin(user, eq(user.id, message.authorUserId))
		.leftJoin(agent, eq(agent.id, message.authorAgentId))
		.where(and(eq(message.threadId, threadId), eq(message.status, "complete")))
		.orderBy(asc(message.createdAt), asc(message.id));
	const placed = await loadPlacedParts(
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
}

/**
 * The system agent's own thread under the one being summarised: one per system agent per
 * thread, created on first use.
 */
/** What the thread holding a thread's summaries is called. */
function summariesTitle(threadTitle: string): string {
	return `Summaries of ${threadTitle}`;
}

async function systemAgentThreadFor(
	db: Executor,
	scope: SummarisedThread,
	summariserId: string,
): Promise<string> {
	const [created] = await db
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
	const [existing] = await db
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
		throw new Error("Preparing a thread summary returned no system-agent thread");
	}
	return existing.id;
}

/** The system agent's turn for this source message: reopened on a retry, created otherwise. */
async function openSystemAgentTurn(
	db: Executor,
	claimed: ClaimedSummary,
	systemAgentThreadId: string,
	summariser: { id: string; model: string },
): Promise<string> {
	const [existing] = await db
		.select({ id: turn.id })
		.from(turn)
		.where(
			and(
				eq(turn.triggerMessageId, claimed.payload.sourceMessageId),
				eq(turn.agentId, summariser.id),
			),
		)
		.limit(1);
	if (existing) {
		await db
			.update(turn)
			.set({ status: "running", error: null, finishedAt: null })
			.where(eq(turn.id, existing.id));
		return existing.id;
	}
	const [created] = await db
		.insert(turn)
		.values({
			threadId: systemAgentThreadId,
			agentId: summariser.id,
			triggerMessageId: claimed.payload.sourceMessageId,
			status: "running",
			model: summariser.model,
			startedAt: new Date(),
		})
		.returning({ id: turn.id });
	if (!created) {
		throw new Error("Turn insert returned no row");
	}
	return created.id;
}
