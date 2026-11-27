import type { OutputOf } from "@sugabots/contracts/operations";
import { HISTORY_SEARCH_MAX_MATCHES } from "@sugabots/contracts/operations/chat-reads";
import { and, asc, desc, eq, gte, ilike, inArray, lt, ne, or, type SQL, sql } from "drizzle-orm";
import { DateTime, Effect } from "effect";
import { type Database, type Executor, query } from "../../database/database.ts";
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

type HistorySearchResult = OutputOf<"chats.searchHistory">;
type HistoryMatch = Extract<HistorySearchResult, { messages: unknown }>["messages"][number];

type HistoryScope<P, Location> =
	| { kind: "chat"; reach: ReachesChat<P, Location> }
	| { kind: "all"; reach: ReachSet<P, Location> };

export const searchHistory = Effect.fn("ChatHistory.searchHistory")(function* <P, Location, X>(
	scope: HistoryScope<P, Location>,
	approved: Approved<P, X, [Location], "chats.searchHistory">,
): Effect.fn.Return<HistorySearchResult, never, Database> {
	const { query: words, after, before } = approved.input;
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
	const complete = sql`${message.status} = 'complete'`;
	const eligibleChat =
		scope.kind === "all"
			? and(
					eq(placedChat.workspaceId, scope.reach.workspace.value),
					scope.reach.reachesChat(placedChat),
				)
			: eq(placedChat.id, scope.reach.chat.value);
	// PostgreSQL can use the actual chat IDs to estimate each match branch's scan.
	const reachedChats =
		scope.kind === "all" && matching
			? yield* query((db) => db.select({ id: placedChat.id }).from(placedChat).where(eligibleChat))
			: undefined;
	if (reachedChats?.length === 0) return { messages: [], more: false };
	const inReachedChat = reachedChats
		? sql`${message.chatId} = any(${sql.param(reachedChats.map(({ id }) => id))}::uuid[])`
		: undefined;
	const eligibleMessage = and(
		inReachedChat,
		complete,
		historyLimit,
		before ? lt(message.createdAt, DateTime.toDate(DateTime.makeUnsafe(before))) : undefined,
		after ? gte(message.createdAt, DateTime.toDate(DateTime.makeUnsafe(after))) : undefined,
	);
	const rows = yield* query((db) => {
		const selection = db
			.select({ message, ...participantColumns })
			.from(message)
			.leftJoin(member, eq(member.id, message.authorMemberId))
			.leftJoin(bot, eq(bot.id, message.authorBotId))
			.$dynamic();
		const matchingMessage =
			matching &&
			(inReachedChat && matching.fileName
				? inArray(message.id, matchAcrossChats(db, matching, eligibleMessage))
				: matchInChat(db, matching));
		const selected = inReachedChat
			? selection.where(and(eligibleMessage, matchingMessage))
			: selection
					.innerJoin(placedChat, eq(placedChat.id, message.chatId))
					.where(and(eligibleChat, eligibleMessage, matchingMessage));
		return selected
			.orderBy(
				...(matching
					? [...matching.best, desc(message.createdAt)]
					: [asc(message.createdAt), asc(message.id)]),
			)
			.limit(HISTORY_SEARCH_MAX_MATCHES + 1);
	});
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
function wordMatch(words: string) {
	const english = sql`to_tsvector('english', ${message.content}) @@ websearch_to_tsquery('english', ${words})`;
	const simple = sql`to_tsvector('simple', ${message.content}) @@ websearch_to_tsquery('simple', ${words})`;
	const patterns = substringTerms(words).map((term) => `%${escapeLike(term)}%`);
	const substring =
		patterns.length > 0
			? and(...patterns.map((pattern) => ilike(message.content, pattern)))
			: undefined;
	const fileName =
		patterns.length > 0 ? and(...patterns.map((pattern) => ilike(file.name, pattern))) : undefined;
	const rank = sql`greatest(
		ts_rank(to_tsvector('english', ${message.content}), websearch_to_tsquery('english', ${words})),
		ts_rank(to_tsvector('simple', ${message.content}), websearch_to_tsquery('simple', ${words}))
	)`;
	return {
		text: or(english, simple, substring),
		fileName,
		best: [desc(sql`(${english}) or (${simple})`), desc(rank)],
	};
}

function matchInChat(db: Executor, match: ReturnType<typeof wordMatch>) {
	if (!match.fileName) return match.text;
	const named = db
		.select({ id: file.id })
		.from(file)
		.where(and(eq(file.messageId, message.id), match.fileName));
	return or(match.text, sql`exists (${named})`);
}

function matchAcrossChats(
	db: Executor,
	match: ReturnType<typeof wordMatch>,
	eligibleMessage: SQL | undefined,
) {
	const text = db.select({ id: message.id }).from(message).where(and(eligibleMessage, match.text));
	const named = db
		.select({ id: message.id })
		.from(message)
		.innerJoin(file, eq(file.messageId, message.id))
		.where(and(eligibleMessage, match.fileName));
	return text.union(named);
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
