import { isoTimestampSchema } from "@sugabots/contracts";
import { tool } from "ai";
import { and, asc, desc, eq, gte, ilike, lt, or, type SQL, sql } from "drizzle-orm";
import { DateTime, Effect, Schema } from "effect";
import { type Executor, query, type RunEffect } from "../../../database/database.ts";
import { agent, type MessageRow, message, threadFile, user } from "../../../database/schema.ts";
import { loadFileParts } from "../../threads/file-parts.ts";
import { describeAttachment, formatHistoryTime } from "../../threads/message-text.ts";
import { type ParticipantRow, participantColumns, toMessage } from "../../threads/participants.ts";

const MAX_MATCHES = 10;
/** Enough of a message to answer from; the whole of a long one would crowd out the others. */
const MATCH_CHARACTERS = 1_500;

export interface HistoryMatch {
	author: string;
	at: string;
	text: string;
}

export type HistorySearchResult =
	| {
			messages: HistoryMatch[];
			/** Whether more messages matched than were returned, so a narrower search would find others. */
			more: boolean;
	  }
	| { refused: string };

/** What to look for: words, a time range, or both. */
interface HistorySearch {
	words?: string;
	after?: Date;
	before?: Date;
}

/**
 * The `search_history` tool: find what was said in this thread before the
 * part the bot reads word for word, which compaction summarises or leaves out.
 */
export function searchHistoryTool({
	threadId,
	before: keptFrom,
	usesSandbox,
	run,
}: {
	threadId: string;
	/** Where the history the bot reads word for word starts, once compacted; nothing from then on is searched. */
	before: Date | undefined;
	/** Whether the agent works in the pod's sandbox, so is told it can copy attachments into it. */
	usesSandbox: boolean;
	run: RunEffect;
}) {
	return tool({
		description: `Search the messages in this thread from before the summary of its earlier history, which you only have that summary of. Give words to look for, in any language, a time range, or both. With words, it returns up to ${MAX_MATCHES} matching messages, best first; with only a time range, the first ${MAX_MATCHES} messages in it, oldest first. Each comes with who wrote it and when. Use it when you need a detail from earlier that the summary leaves out, or what was said around a particular time.`,
		inputSchema: Schema.Struct({
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
		}).pipe(Schema.toStandardSchemaV1, Schema.toStandardJSONSchemaV1),
		execute: async ({ query: words, after, before }): Promise<HistorySearchResult> => {
			if (!words && !after && !before) {
				return { refused: "Give words to look for, a time range, or both." };
			}
			if (!keptFrom) {
				return {
					refused:
						"You have this thread's whole history already; there is nothing older to search.",
				};
			}
			const search: HistorySearch = {
				...(words ? { words } : {}),
				...(after ? { after: DateTime.toDate(DateTime.makeUnsafe(after)) } : {}),
				...(before ? { before: DateTime.toDate(DateTime.makeUnsafe(before)) } : {}),
			};
			return run(query((db) => searchHistory(db, threadId, keptFrom, search, usesSandbox)));
		},
	});
}

const searchHistory = Effect.fn("SearchHistory.searchHistory")(function* (
	db: Executor,
	threadId: string,
	keptFrom: Date,
	{ words, after, before }: HistorySearch,
	usesSandbox: boolean,
) {
	const until = before && before < keptFrom ? before : keptFrom;
	const matching = words ? wordMatch(words) : undefined;
	const conditions: SQL[] = [
		eq(message.threadId, threadId),
		eq(message.status, "complete"),
		lt(message.createdAt, until),
		...(after ? [gte(message.createdAt, after)] : []),
		...(matching ? [matching.where] : []),
	];
	const rows = yield* db
		.select({ message, ...participantColumns })
		.from(message)
		.leftJoin(user, eq(user.id, message.authorUserId))
		.leftJoin(agent, eq(agent.id, message.authorAgentId))
		.where(and(...conditions))
		.orderBy(
			...(matching
				? [...matching.best, desc(message.createdAt)]
				: [asc(message.createdAt), asc(message.id)]),
		)
		// One more than is returned, to tell whether there are more.
		.limit(MAX_MATCHES + 1);
	const returned = rows.slice(0, MAX_MATCHES);
	// Each message lists the files it carried, so a file found this way can be read again.
	const files = yield* loadFileParts(
		db,
		returned.map(({ message: row }) => row.id),
	);
	return {
		messages: returned.map(({ message: row, ...author }) =>
			toHistoryMatch(
				row,
				author,
				(files.get(row.id) ?? []).map((file) => describeAttachment(file, { usesSandbox })),
			),
		),
		more: rows.length > MAX_MATCHES,
	};
});

/**
 * A found message as a bot is given it: who wrote it, when, and what it said,
 * cut short when long, followed by a line for each file it carried.
 */
export function toHistoryMatch(
	row: MessageRow,
	author: ParticipantRow,
	attachmentLines: readonly string[],
): HistoryMatch {
	const found = toMessage(row, author);
	const said =
		row.content.length <= MATCH_CHARACTERS
			? row.content
			: `${row.content.slice(0, MATCH_CHARACTERS)}…`;
	return {
		author: found.author.kind === "routine_trigger" ? found.author.routineName : found.author.name,
		at: formatHistoryTime(row.createdAt),
		text: [said, ...attachmentLines].filter((line) => line !== "").join("\n"),
	};
}

/**
 * Which messages match `words`, and how to put the best first. Three ways,
 * any of which will do:
 *
 * - English full-text, stemmed, so "hotels" finds "hotel".
 * - Full-text without stemming or stop words, so a word the English rules
 *   drop or change (German "was", a French plural) still matches as written.
 * - Every word as a substring, for scripts written without spaces between
 *   words, which full-text cannot split, and for anything the others miss.
 *
 * Full-text matches come first, ranked by the better of their two scores;
 * substring-only matches follow. Each expression is the one its index on
 * `message.content` is built on, so the indexes are used.
 */
export function wordMatch(words: string): { where: SQL; best: SQL[] } {
	const english = sql`to_tsvector('english', ${message.content}) @@ websearch_to_tsquery('english', ${words})`;
	const simple = sql`to_tsvector('simple', ${message.content}) @@ websearch_to_tsquery('simple', ${words})`;
	const terms = substringTerms(words);
	const substring =
		terms.length > 0
			? and(...terms.map((term) => ilike(message.content, `%${escapeLike(term)}%`)))
			: undefined;
	// A file is found by its name too, as a message with only files says nothing else.
	const carriesNamed =
		terms.length > 0
			? sql`exists (select 1 from ${threadFile} where ${threadFile.messageId} = ${message.id} and ${and(
					...terms.map((term) => ilike(threadFile.name, `%${escapeLike(term)}%`)),
				)})`
			: undefined;
	const rank = sql`greatest(
		ts_rank(to_tsvector('english', ${message.content}), websearch_to_tsquery('english', ${words})),
		ts_rank(to_tsvector('simple', ${message.content}), websearch_to_tsquery('simple', ${words}))
	)`;
	return {
		where: or(english, simple, substring, carriesNamed) as SQL,
		best: [desc(sql`(${english}) or (${simple})`), desc(rank)],
	};
}

/**
 * The words to find as substrings: quotes dropped, and the search syntax's
 * `OR` and excluded `-words` left out, since a substring cannot say either.
 */
function substringTerms(words: string): string[] {
	return words
		.replaceAll('"', " ")
		.split(/\s+/)
		.filter((term) => term !== "" && term !== "OR" && !term.startsWith("-"));
}

/** `term` with LIKE's wildcards taken literally. */
export function escapeLike(term: string): string {
	return term.replace(/[\\%_]/g, (character) => `\\${character}`);
}
