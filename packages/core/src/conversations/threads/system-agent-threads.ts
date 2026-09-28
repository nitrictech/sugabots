import { and, asc, eq } from "drizzle-orm";
import { Effect } from "effect";
import type { Executor } from "../../database/database.ts";
import { agent, message, thread, user } from "../../database/schema.ts";
import { messageTextWithPlacedParts } from "./message-text.ts";
import { participantColumns, toMessage } from "./participants.ts";
import { loadPlacedParts } from "./placed-parts.ts";

/**
 * What the system agents that work on a thread after a reply (the Scribe and
 * the Compaction agent) read: the thread they work on, and its transcript.
 * Each keeps its own turns in a child thread that `ThreadRepository` opens.
 */

/** The thread a system agent works on, as much of it as preparing that work needs. */
export interface SystemAgentScope {
	threadId: string;
	podId: string;
	workspaceId: string;
	threadTitle: string;
	initiatorUserId: string | null;
	/** The model of the agent whose reply asked for this work, which reads the thread next. */
	agentModel: string | null;
}

/** One message of a transcript, as a system agent reads it. */
export interface TranscriptEntry {
	author: string;
	kind: "person" | "agent";
	content: string;
}

/**
 * The thread, if it still exists and still has the source message and the
 * agent whose reply asked for this work.
 */
export const loadSystemAgentScope = Effect.fn("SystemAgentThreads.loadSystemAgentScope")(function* (
	db: Executor,
	request: { threadId: string; agentId: string; sourceMessageId: string },
) {
	const [row] = yield* db
		.select({
			threadId: thread.id,
			podId: thread.podId,
			workspaceId: thread.workspaceId,
			threadTitle: thread.title,
			initiatorUserId: thread.initiatorUserId,
			agentModel: agent.model,
		})
		.from(thread)
		// The agent in the payload is whoever's reply triggered this, not the
		// system agent doing the work, and not necessarily the thread's host:
		// requiring the host meant a shared thread stopped being worked on the
		// moment anyone but the host replied.
		.innerJoin(agent, eq(agent.id, request.agentId))
		.innerJoin(
			message,
			and(eq(message.id, request.sourceMessageId), eq(message.threadId, thread.id)),
		)
		.where(eq(thread.id, request.threadId))
		.limit(1);
	return row satisfies SystemAgentScope | undefined;
});

/**
 * Every complete message in the thread, oldest first. A message with nothing
 * to read, such as a reply that only called tools that left no record, has no
 * `entry`.
 */
export const loadTranscript = Effect.fn("SystemAgentThreads.loadTranscript")(function* (
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
		const entry: TranscriptEntry | undefined = content
			? {
					author: authorName,
					kind: hydrated.author.kind === "person" ? "person" : "agent",
					content,
				}
			: undefined;
		return { id: row.id, createdAt: row.createdAt, entry };
	});
});
