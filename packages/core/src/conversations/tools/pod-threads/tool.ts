import { isoTimestampSchema } from "@sugabots/contracts";
import { tool } from "ai";
import { and, desc, eq, gte, ilike, inArray, isNull, lt, ne, type SQL } from "drizzle-orm";
import { DateTime, Effect, Schema } from "effect";
import { type Executor, query, type RunEffect } from "../../../database/database.ts";
import {
	agent,
	CONVERSATION_TYPES,
	type MessageRow,
	message,
	thread,
	user,
} from "../../../database/schema.ts";
import { isUuid } from "../../../ids/ids.ts";
import { type CursorPoint, decodeCursor, earlierThan, encodeCursor } from "../../cursor.ts";
import { loadFileParts } from "../../threads/file-parts.ts";
import { describeAttachmentElsewhere, formatHistoryTime } from "../../threads/message-text.ts";
import { participantColumns } from "../../threads/participants.ts";
import {
	escapeLike,
	type HistoryMatch,
	toHistoryMatch,
	wordMatch,
} from "../search-history/tool.ts";

export const LIST_THREADS_TOOL = "list_threads";
export const READ_THREAD_TOOL = "read_thread";

const MAX_LISTED_THREADS = 30;
/** Messages one read returns, at most. */
const MAX_READ_MESSAGES = 20;
/**
 * Most characters of messages one read returns, as JSON escapes them: fewer
 * messages than `MAX_READ_MESSAGES` when they are long. Below the size at
 * which a tool's result is kept as a file instead, so a read is never itself
 * turned into one.
 */
const MAX_READ_CHARACTERS = 40_000;

/** What a thread is, as the bot is told: what people see it as in the pod. */
type ThreadKind = "thread" | "pod chat" | "routine";

export interface ListedThread {
	id: string;
	kind: ThreadKind;
	title: string;
	/** The bot the thread is with; none on a pod chat or a thread between people. */
	bot?: string;
	/** When somebody last posted in it, or it last changed. */
	lastActiveAt: string;
	/** Whether somebody marked it done. */
	done: boolean;
}

export interface ListThreadsResult {
	threads: ListedThread[];
	/** Whether more threads matched than were listed, so a narrower search would find others. */
	more: boolean;
}

export type ReadThreadResult =
	| {
			thread: { id: string; title: string };
			/** On a thread started from a message in a pod chat: that message, which the thread answers. */
			startedFrom?: HistoryMatch;
			messages: HistoryMatch[];
			/**
			 * Without words to look for, where to read back from: pass it as
			 * `continueFrom` for the messages before these. None once the first is read.
			 */
			continueFrom?: string;
			/** With words, whether more messages matched than were returned, so narrower words would find others. */
			more?: boolean;
	  }
	| { refused: string };

/**
 * The `list_threads` and `read_thread` tools: what else is being said in the
 * bot's pod. They read only the pod's threads that its people open and post
 * in, which everyone who can see the pod can read, so a bot quoting one shows
 * nobody in its own thread anything they could not open themselves. A bot's
 * own thread is left out: it has that already.
 */
export function podThreadTools({
	podId,
	threadId,
	run,
}: {
	podId: string;
	/** The thread the bot is in, which it has already and is not offered. */
	threadId: string;
	run: RunEffect;
}) {
	const readable: ReadableThreads = { podId, except: threadId };
	return {
		[LIST_THREADS_TOOL]: tool({
			description: `List the other threads in this pod: threads with bots or between people, pod chats, and routines' threads, most recently active first, up to ${MAX_LISTED_THREADS}. Each comes with its id, title, the bot it is with, when it was last active, and whether it is done. Give \`title\` to find threads with all of some words in their title. Read one with ${READ_THREAD_TOOL}.`,
			inputSchema: Schema.Struct({
				title: Schema.optional(
					Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(200)).annotate({
						description: 'Only threads whose title contains these words, like "launch plan".',
					}),
				),
			}).pipe(Schema.toStandardSchemaV1, Schema.toStandardJSONSchemaV1),
			execute: ({ title }): Promise<ListThreadsResult> =>
				run(query((db) => listThreads(db, readable, title))),
		}),
		[READ_THREAD_TOOL]: tool({
			description: `Read another thread in this pod, by the id ${LIST_THREADS_TOOL} gave. Without words to look for, returns up to its newest ${MAX_READ_MESSAGES} messages, oldest first, and a \`continueFrom\` to read back from for earlier ones. With words, returns up to ${MAX_READ_MESSAGES} matching messages, best first. Either can be limited to a time range. Each comes with who wrote it and when, with a long message cut short. A thread started from a message in a pod chat comes with that message as \`startedFrom\`. Use it when someone refers to what was said elsewhere in the pod, or the work there bears on what you're doing.`,
			inputSchema: Schema.Struct({
				thread: Schema.String.annotate({ description: "The thread's id." }),
				query: Schema.optional(
					Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(500)).annotate({
						description:
							'Words to look for, like "hotel budget". Supports "quoted phrases", OR, and -excluded words.',
					}),
				),
				after: Schema.optional(
					isoTimestampSchema.annotate({
						description: "Only messages written at or after this time, like 2026-05-15T17:00:00Z",
					}),
				),
				before: Schema.optional(
					isoTimestampSchema.annotate({
						description: "Only messages written before this time, like 2026-05-15T18:00:00Z",
					}),
				),
				continueFrom: Schema.optional(
					Schema.String.annotate({
						description: "The `continueFrom` an earlier read gave, to read the messages before it.",
					}),
				),
			}).pipe(Schema.toStandardSchemaV1, Schema.toStandardJSONSchemaV1),
			execute: ({
				thread: id,
				query: words,
				after,
				before,
				continueFrom,
			}): Promise<ReadThreadResult> => {
				const continuePoint = continueFrom ? decodeCursor(continueFrom) : undefined;
				if (continueFrom && !continuePoint) {
					return Promise.resolve({
						refused:
							"That `continueFrom` is not one a read gave. Read the thread again from its newest.",
					});
				}
				if (continueFrom && words) {
					return Promise.resolve({
						refused:
							"`continueFrom` reads on from the newest messages, not from a search. Give words or `continueFrom`, not both.",
					});
				}
				return run(
					query((db) =>
						readThread(db, readable, id, {
							...(words ? { words } : {}),
							...(after ? { after: DateTime.toDate(DateTime.makeUnsafe(after)) } : {}),
							...(before ? { before: DateTime.toDate(DateTime.makeUnsafe(before)) } : {}),
							...(continuePoint ? { continueFrom: continuePoint } : {}),
						}),
					),
				);
			},
		}),
	};
}

/** The pod whose threads are read, and the bot's own thread, which is not. */
interface ReadableThreads {
	podId: string;
	except: string;
}

/** The threads the bot may read: the pod's conversations, chats and routine threads, but not archived chats. */
function readableWhere({ podId, except }: ReadableThreads): SQL {
	return and(
		eq(thread.podId, podId),
		inArray(thread.type, [...CONVERSATION_TYPES]),
		isNull(thread.archivedAt),
		ne(thread.id, except),
	) as SQL;
}

const listThreads = Effect.fn("PodThreads.listThreads")(function* (
	db: Executor,
	readable: ReadableThreads,
	title: string | undefined,
) {
	const titleWords = title?.split(/\s+/).filter((word) => word !== "") ?? [];
	const rows = yield* db
		.select({
			id: thread.id,
			type: thread.type,
			title: thread.title,
			doneAt: thread.doneAt,
			bot: agent.name,
			updatedAt: thread.updatedAt,
		})
		.from(thread)
		.leftJoin(agent, eq(agent.id, thread.hostAgentId))
		.where(
			and(
				readableWhere(readable),
				...titleWords.map((word) => ilike(thread.title, `%${escapeLike(word)}%`)),
			),
		)
		// As people's thread lists order them: posting in a thread marks it updated.
		.orderBy(desc(thread.updatedAt), desc(thread.id))
		// One more than is listed, to tell whether there are more.
		.limit(MAX_LISTED_THREADS + 1);
	return {
		threads: rows.slice(0, MAX_LISTED_THREADS).map(
			(row): ListedThread => ({
				id: row.id,
				kind:
					row.type === "pod_chat" ? "pod chat" : row.type === "routine_feed" ? "routine" : "thread",
				title: row.title,
				...(row.bot ? { bot: row.bot } : {}),
				lastActiveAt: formatHistoryTime(row.updatedAt),
				done: row.doneAt !== null,
			}),
		),
		more: rows.length > MAX_LISTED_THREADS,
	};
});

/** What to read: words to look for, a time range, both, or neither for the newest. */
interface ThreadRead {
	words?: string;
	after?: Date;
	before?: Date;
	/** Where an earlier read of the newest stopped, to read on from. */
	continueFrom?: CursorPoint;
}

const NOT_READABLE = {
	refused: `There is no other thread in this pod with that id. ${LIST_THREADS_TOOL} lists the ones you can read.`,
};

const readThread = Effect.fn("PodThreads.readThread")(function* (
	db: Executor,
	readable: ReadableThreads,
	threadId: string,
	{ words, after, before, continueFrom }: ThreadRead,
) {
	if (!isUuid(threadId)) return NOT_READABLE;
	const [found] = yield* db
		.select({ id: thread.id, title: thread.title, originMessageId: thread.originMessageId })
		.from(thread)
		.where(and(eq(thread.id, threadId), readableWhere(readable)))
		.limit(1);
	if (!found) return NOT_READABLE;
	const about = { id: found.id, title: found.title };
	const [startedFrom] = found.originMessageId
		? yield* foundMessages(
				db,
				and(eq(message.id, found.originMessageId), eq(message.status, "complete")) as SQL,
				[],
			)
		: [];
	const matching = words ? wordMatch(words) : undefined;
	const rows = yield* foundMessages(
		db,
		and(
			eq(message.threadId, found.id),
			eq(message.status, "complete"),
			...(after ? [gte(message.createdAt, after)] : []),
			...(before ? [lt(message.createdAt, before)] : []),
			...(continueFrom ? [earlierThan(message.createdAt, message.id, continueFrom)] : []),
			...(matching ? [matching.where] : []),
		) as SQL,
		matching
			? [...matching.best, desc(message.createdAt)]
			: [desc(message.createdAt), desc(message.id)],
		// One more than can be returned, to tell whether there are more.
		MAX_READ_MESSAGES + 1,
	);
	const page = withinCharacters(rows.slice(0, MAX_READ_MESSAGES));
	const more = rows.length > page.length;
	// Read back from the newest, a page is given oldest first, as a thread reads.
	const returned = matching ? page : page.toReversed();
	const messages = returned.map(({ found: match }) => match);
	const startedFromPart = startedFrom ? { startedFrom: startedFrom.found } : {};
	if (matching) return { thread: about, ...startedFromPart, messages, more };
	const oldest = returned[0]?.row;
	return {
		thread: about,
		...startedFromPart,
		messages,
		...(more && oldest
			? { continueFrom: encodeCursor({ at: oldest.createdAt, id: oldest.id }) }
			: {}),
	};
});

/** A message as the bot is given it, with the row it was read from. */
interface FoundMessage {
	row: MessageRow;
	found: HistoryMatch;
}

/** The messages `where` picks, in `order`, each with its author and the files it carried. */
const foundMessages = Effect.fn("PodThreads.foundMessages")(function* (
	db: Executor,
	where: SQL,
	order: SQL[],
	limit = 1,
) {
	const rows = yield* db
		.select({ message, ...participantColumns })
		.from(message)
		.leftJoin(user, eq(user.id, message.authorUserId))
		.leftJoin(agent, eq(agent.id, message.authorAgentId))
		.where(where)
		.orderBy(...order)
		.limit(limit);
	const files = yield* loadFileParts(
		db,
		rows.map(({ message: row }) => row.id),
	);
	return rows.map(
		({ message: row, ...author }): FoundMessage => ({
			row,
			found: toHistoryMatch(
				row,
				author,
				(files.get(row.id) ?? []).map(describeAttachmentElsewhere),
			),
		}),
	);
});

/**
 * The first of `messages` that fit in `MAX_READ_CHARACTERS` as JSON, and at
 * least one, so a read always moves on.
 */
function withinCharacters(messages: readonly FoundMessage[]): FoundMessage[] {
	const fitting: FoundMessage[] = [];
	let characters = 0;
	for (const message of messages) {
		characters += JSON.stringify(message.found).length;
		if (fitting.length > 0 && characters > MAX_READ_CHARACTERS) break;
		fitting.push(message);
	}
	return fitting;
}
