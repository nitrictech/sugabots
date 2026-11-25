import type { InputOf, OutputOf } from "@sugabots/contracts/operations";
import { HISTORY_SEARCH_MAX_MATCHES } from "@sugabots/contracts/operations/chat-reads";
import { and, asc, desc, eq, gte, ilike, lt, ne, or, type SQL, sql } from "drizzle-orm";
import { DateTime, Effect } from "effect";
import { type Database, query } from "../../database/database.ts";
import {
	bot,
	chatCompaction,
	file,
	type MessageRow,
	member,
	message,
	placedChat,
} from "../../database/schema.ts";
import type { Approved } from "../../proofs/approved.ts";
import type { ReachSet } from "../../proofs/reach-set.ts";
import type { ReachesChat } from "../../proofs/reaches-chat.ts";
import { loadFileParts } from "../store/file-parts.ts";
import { describeAttachment, formatHistoryTime } from "../store/message-text.ts";
import { type ParticipantRow, participantColumns, toMessage } from "../store/participants.ts";

/** Enough of a message to answer from; the whole of a long one would crowd out the others. */
const MATCH_CHARACTERS = 1_500;

export const EMPTY_HISTORY_SEARCH = "Give words to look for, a time range, or both.";

type HistorySearchInput = Omit<InputOf<"chats.searchHistory">, "chat">;
type HistorySearchResult = OutputOf<"chats.searchHistory">;
type HistoryMatch = Extract<HistorySearchResult, { messages: unknown }>["messages"][number];

type HistoryScope<P, Location> =
	| { kind: "chat"; reach: ReachesChat<P, Location> }
	| { kind: "all"; reach: ReachSet<P, Location> };

export const searchHistory = Effect.fn("ChatHistory.searchHistory")(function* <P, Location, X>(
	scope: HistoryScope<P, Location>,
	{ query: words, after, before }: HistorySearchInput,
	approved: Approved<P, X, [Location], "chats.searchHistory">,
): Effect.fn.Return<HistorySearchResult, never, Database> {
	if (!words && !after && !before) {
		return { refused: EMPTY_HISTORY_SEARCH };
	}
	const principal = approved.principal.value;
	const turnBot =
		principal._tag === "BotForAsker" || principal._tag === "AutomationRun" ? principal : undefined;
	const searchesCurrentChat =
		turnBot !== undefined && (scope.kind === "all" || scope.reach.chat.value === turnBot.chat);
	const [current] = searchesCurrentChat
		? yield* query((db) =>
				db
					.select({ keptFrom: chatCompaction.keptFrom, usesComputer: bot.usesComputer })
					.from(bot)
					.leftJoin(chatCompaction, eq(chatCompaction.chatId, turnBot.chat))
					.where(eq(bot.id, turnBot.bot)),
			)
		: [];
	if (searchesCurrentChat && scope.kind === "chat" && !current?.keptFrom) {
		return {
			refused: "You have the whole history here already; there is nothing older to search.",
		};
	}

	// Keep the current chat's search before the messages the turn can read in its prompt.
	const otherChat = searchesCurrentChat ? ne(message.chatId, turnBot.chat) : undefined;
	const beforeKept = current?.keptFrom ? lt(message.createdAt, current.keptFrom) : undefined;
	const historyLimit = or(otherChat, beforeKept);
	const matching = words ? wordMatch(words) : undefined;
	const conditions: SQL[] = [
		scope.kind === "all"
			? scope.reach.reachesChat(placedChat)
			: eq(message.chatId, scope.reach.chat.value),
		eq(message.status, "complete"),
		...(historyLimit ? [historyLimit] : []),
		...(before ? [lt(message.createdAt, DateTime.toDate(DateTime.makeUnsafe(before)))] : []),
		...(after ? [gte(message.createdAt, DateTime.toDate(DateTime.makeUnsafe(after)))] : []),
		...(matching ? [matching.where] : []),
	];
	const rows = yield* query((db) =>
		db
			.select({ message, ...participantColumns })
			.from(message)
			.innerJoin(placedChat, eq(placedChat.id, message.chatId))
			.leftJoin(member, eq(member.id, message.authorMemberId))
			.leftJoin(bot, eq(bot.id, message.authorBotId))
			.where(and(...conditions))
			.orderBy(
				...(matching
					? [...matching.best, desc(message.createdAt)]
					: [asc(message.createdAt), asc(message.id)]),
			)
			// One more than is returned, to tell whether there are more.
			.limit(HISTORY_SEARCH_MAX_MATCHES + 1),
	);
	const returned = rows.slice(0, HISTORY_SEARCH_MAX_MATCHES);
	// Each message lists the files it carried, so a file found this way can be read again.
	const files = yield* query((db) =>
		loadFileParts(
			db,
			returned.map(({ message: row }) => row.id),
		),
	);
	return {
		messages: returned.map(({ message: row, ...author }) => {
			const usesComputer = current?.usesComputer === true && row.chatId === turnBot?.chat;
			const match = toHistoryMatch(
				row,
				author,
				(files.get(row.id) ?? []).map((file) => describeAttachment(file, { usesComputer })),
			);
			return scope.kind === "all" ? { ...match, chatId: row.chatId } : match;
		}),
		more: rows.length > HISTORY_SEARCH_MAX_MATCHES,
	};
});

/**
 * A found message as a bot is given it: who wrote it, when, and what it said,
 * cut short when long, followed by a line for each file it carried.
 */
function toHistoryMatch(
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
		author:
			found.author.kind === "automation_trigger" ? found.author.automationName : found.author.name,
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
function wordMatch(words: string): { where: SQL; best: SQL[] } {
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
			? sql`exists (select 1 from ${file} where ${file.messageId} = ${message.id} and ${and(
					...terms.map((term) => ilike(file.name, `%${escapeLike(term)}%`)),
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
function escapeLike(term: string): string {
	return term.replace(/[\\%_]/g, (character) => `\\${character}`);
}
