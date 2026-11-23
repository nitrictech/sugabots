export * as ChatDetailsView from "./chat-details-view.ts";

import type {
	BotParticipant,
	ChatContext,
	ChatDetails,
	ChatHistoryQuery,
	PlacedChat,
} from "@sugabots/contracts";
import { DEFAULT_CHAT_HISTORY_LIMIT } from "@sugabots/contracts";
import { userText } from "@sugabots/errors";
import { and, eq, type SQLWrapper, sql } from "drizzle-orm";
import { Context, Data, DateTime, Effect, Layer } from "effect";
import {
	type ChatStanding,
	computerProjectStandingFor,
	mayDecideToolCall,
	peopleReachingProject,
	ResourceHidden,
} from "../authorization/access.ts";
import { CurrentActor } from "../authorization/current-actor.ts";
import { Visibility } from "../authorization/visibility.ts";
import { type Executor, query, serviceOperations } from "../database/database.ts";
import type * as schema from "../database/schema.ts";
import { automation, chatCompaction, person, placedChat, turn } from "../database/schema.ts";
import { isUuid } from "../ids/ids.ts";
import type { UserFacing } from "../user-message.ts";
import { automationFailing, resultPosted, runBotFactsOf, toRun } from "./automations/execution.ts";
import { compactionLineTokens } from "./compaction/window.ts";
import { type CursorPoint, decodeCursor, earlierThan, encodeCursor } from "./cursor.ts";
import {
	authorRow,
	botColumns,
	messageFromRelations,
	messageRelations,
	type PersonIdentity,
	personColumns,
	personJson,
	toParticipant,
	toPerson,
} from "./store/participants.ts";
import { Turns } from "./turns/turns.ts";

/**
 * What the chat screens show, of the chats the current actor can see: a
 * chat with its messages, and how much of its bot's context window it fills.
 */
export interface Interface {
	readonly get: (
		chatId: string,
		history?: ChatHistoryQuery,
	) => Effect.Effect<ChatDetails, ResourceHidden | InvalidChatHistoryCursor, CurrentActor.Service>;
	/** How much of its bot's context window the chat fills; null until a reply in it has been measured. */
	readonly context: (
		chatId: string,
	) => Effect.Effect<ChatContext | null, ResourceHidden, CurrentActor.Service>;
}

export class Service extends Context.Service<Service, Interface>()(
	"@sugabots/core/ChatDetailsView",
) {}

export const make = Effect.gen(function* () {
	const operation = yield* serviceOperations<Interface>("ChatDetailsView");
	const visibility = yield* Visibility.Service;
	return Service.of({
		get: (chatId, history = { limit: DEFAULT_CHAT_HISTORY_LIMIT }) =>
			operation(
				"get",
				Effect.gen(function* () {
					yield* Effect.annotateCurrentSpan("chat.id", chatId);
					// Before anything is looked up, and whether or not the chat is there,
					// so a bad cursor says nothing about the chat.
					const before = history.cursor ? yield* historyCursor(history.cursor) : undefined;
					const standing = yield* visibility.chatStanding(chatId);
					const row = yield* query((db) => loadChat(db, standing.chat.id, history.limit, before));
					if (!row) return yield* new ResourceHidden({ resource: "chat" });
					const computerApprovers = yield* computerRequestApproversIn(row, standing);
					const details = toChatDetails(row, standing, computerApprovers, history.limit);
					const { automationId } = row;
					if (!automationId) return details;
					const [owned] = yield* query((db) =>
						db
							.select({
								id: automation.id,
								projectId: automation.projectId,
								state: automation.state,
								failed: automationFailing(),
								pausedAfterFailuresAt: automation.pausedAfterFailuresAt,
							})
							.from(automation)
							.where(eq(automation.id, automationId))
							.limit(1),
					);
					if (!owned) return details;
					const { pausedAfterFailuresAt, ...stands } = owned;
					return {
						...details,
						automation: { ...stands, pausedAfterFailures: pausedAfterFailuresAt !== null },
					};
				}),
			),

		context: (chatId) =>
			operation(
				"context",
				Effect.gen(function* () {
					if (!isUuid(chatId)) return yield* new ResourceHidden({ resource: "chat" });
					const reachesChat = yield* visibility.reachesChat;
					const [row] = yield* query((db) =>
						db
							.select({
								measured: latestMeasurementOf(placedChat.id),
								compactedAt: chatCompaction.updatedAt,
							})
							.from(placedChat)
							.leftJoin(chatCompaction, eq(chatCompaction.chatId, placedChat.id))
							.where(and(eq(placedChat.id, chatId), reachesChat(placedChat))),
					);
					if (!row) return yield* new ResourceHidden({ resource: "chat" });
					return row.measured === null ? null : toChatContext(row.measured, row.compactedAt);
				}),
			),
	});
});

export const layerNoDeps = Layer.effect(Service, make);

export const layer = layerNoDeps.pipe(Layer.provide(Visibility.layer));

export class InvalidChatHistoryCursor
	extends Data.TaggedError("InvalidChatHistoryCursor")
	implements UserFacing
{
	get userMessage() {
		return userText`That chat history cursor is invalid`;
	}
}

/**
 * The chat `chatId`, a page of its messages with their authors and the parts
 * placed in them, its participants, its project's bots and the people who reach
 * its project: one statement.
 */
const loadChat = Effect.fn("ChatDetailsView.loadChat")(function* (
	db: Executor,
	chatId: string,
	limit: number,
	before: CursorPoint | undefined,
) {
	return yield* db.query.placedChat.findFirst({
		where: { id: chatId },
		extras: {
			running: (row) => Turns.busyIn(sql`${row.id}`),
			queuedSince: (row) => Turns.queuedSince(sql`${row.id}`),
			// Who decides the approvals of a run, and of a collaboration in one, turns on the run's bot.
			runBot: (row) => runBotFactsOf(row.id),
			// Not the project's members: a bot's default project has none, and the
			// floor reads mentions of everyone who reaches the project.
			peopleReachingProject: (row) => sql<PersonIdentity[]>`(
				select coalesce(json_agg(${personJson} order by ${person.name}), '[]'::json)
				from ${person}
				where ${person.id} in (${peopleReachingProject(sql`${row.projectId}`)})
			)`,
		},
		with: {
			project: {
				columns: {},
				with: {
					bots: {
						...botColumns,
						where: { systemBotKey: { isNull: true } },
						orderBy: { name: "asc" },
					},
				},
			},
			participants: {
				columns: {},
				orderBy: { createdAt: "asc", id: "asc" },
				with: { person: personColumns, bot: botColumns },
			},
			reads: {
				columns: { readThrough: true, updatedAt: true },
				with: { person: personColumns },
			},
			automationRun: { extras: { posted: (row) => resultPosted(sql`${row.id}`) } },
			messages: {
				// One more than the page, so an older page is known to exist without a count.
				limit: limit + 1,
				orderBy: { createdAt: "desc", id: "desc" },
				...(before && {
					where: {
						RAW: (row) => earlierThan(row.createdAt, row.id, before),
					},
				}),
				with: {
					...messageRelations,
					// A failed reply's reason, and when it ended, live on its turn.
					turn: { columns: { error: true, finishedAt: true } },
				},
			},
		},
	});
});

type Chat = NonNullable<Effect.Success<ReturnType<typeof loadChat>>>;

/**
 * The bots that speak in the chat, its own and any taking part, whose
 * requests to change the computer they work on the caller may decide: those
 * who manage that computer's project, the chat's, or in a
 * collaboration the bot's own default project. Outside a collaboration every
 * bot works on the chat's project, in which the caller's `standing`
 * is already known.
 */
const computerRequestApproversIn = Effect.fn("ChatDetailsView.computerRequestApproversIn")(
	function* (row: Chat, standing: ChatStanding) {
		const speakers = new Set(
			[row.botId, ...row.participants.map(({ bot: participant }) => participant?.id)].filter(
				(id): id is string => typeof id === "string",
			),
		);
		if (row.kind !== "collaboration") {
			const managesComputer = standing.standing.may("computer.request.decide");
			return managesComputer ? [...speakers] : [];
		}
		const { personId } = yield* CurrentActor.Service;
		const deciding: string[] = [];
		for (const botId of speakers) {
			const standing = yield* query((db) =>
				computerProjectStandingFor(db, row.id, botId, personId),
			);
			if (standing?.may("computer.request.decide")) deciding.push(botId);
		}
		return deciding;
	},
);

function toChatDetails(
	row: Chat,
	standing: ChatStanding,
	computerApprovers: readonly string[],
	limit: number,
): ChatDetails {
	const page = row.messages.slice(0, limit).reverse();
	const oldest = page[0];
	return {
		chat: toPlacedChat(row, row.running),
		// What this person may do with the approvals this chat raises, decided
		// once here so the chat does not have to work it out from a role.
		capabilities: {
			approveToolCalls: mayDecideToolCall(
				standing.standing,
				undefined,
				row.runBot ?? undefined,
				"chat",
			),
			approveComputerRequestsOf: computerApprovers,
		},
		// A run is always listed in its automation's feed.
		automationRun:
			row.automationRun && row.rootChatId
				? toRun(row.automationRun, row.rootChatId, row.automationRun.posted)
				: null,
		participants: row.participants.map(({ person, bot: participant }) =>
			toParticipant(authorRow(person, participant)),
		),
		projectBots: (row.project?.bots ?? []).map((bot): BotParticipant => ({ kind: "bot", ...bot })),
		peopleReachingProject: row.peopleReachingProject.map(toPerson),
		messages: page.map((stored) => messageFromRelations(stored, stored.turn)),
		olderMessagesCursor:
			row.messages.length > limit && oldest
				? encodeCursor({ at: oldest.createdAt, id: oldest.id })
				: null,
		queuedSince: row.queuedSince,
		reads: row.reads.map((read) => ({
			person: toPerson(read.person),
			readThrough: read.readThrough.toISOString(),
			// Written whenever they read further, so when they last did.
			readAt: read.updatedAt.toISOString(),
		})),
	};
}

/**
 * How many tokens the prompt of the chat's latest measured turn took,
 * the window it was read with, and when. Its own turns only: the Compaction
 * bot's are in a system chat of its own.
 */
const latestMeasurementOf = (chatId: SQLWrapper) => sql<Measurement | null>`(
	select json_build_object('tokens', ${turn.contextTokens}, 'window', ${turn.contextCapacity}, 'at', coalesce(${turn.finishedAt}, ${turn.createdAt}))
	from ${turn}
	where ${turn.chatId} = ${chatId} and ${turn.contextTokens} is not null
	order by ${turn.createdAt} desc
	limit 1
)`;

/** A turn's prompt size, the window it was read with (unset on older turns), and when. */
interface Measurement {
	tokens: number;
	window: number | null;
	at: string;
}

/** The context the chat's latest measured turn used, against the window that turn read with. */
function toChatContext(measured: Measurement, compactedAt: Date | null): ChatContext {
	const windowTokens = Turns.contextWindowTokens(measured.window);
	return {
		usedTokens: measured.tokens,
		measuredAt: DateTime.formatIso(DateTime.makeUnsafe(measured.at)),
		windowTokens,
		compactionLineTokens: compactionLineTokens(windowTokens),
		compactedAt: compactedAt?.toISOString() ?? null,
	};
}

const historyCursor = (cursor: string) => {
	const point = decodeCursor(cursor);
	return point ? Effect.succeed(point) : Effect.fail(new InvalidChatHistoryCursor());
};

function toPlacedChat(row: schema.PlacedChatRow, running: boolean): PlacedChat {
	return {
		id: row.id,
		workspaceId: row.workspaceId,
		projectId: row.projectId,
		botId: row.botId,
		rootChatId: row.rootChatId,
		kind: row.kind,
		title: row.title,
		status: running ? "running" : "done",
		parentChatId: row.parentChatId,
		resolvedAt: row.resolvedAt?.toISOString() ?? null,
		createdAt: row.createdAt.toISOString(),
		updatedAt: row.updatedAt.toISOString(),
	};
}
