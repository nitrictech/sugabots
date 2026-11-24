export * as ChatDetailsView from "./chat-details-view.ts";

import type {
	BotParticipant,
	ChatContext,
	ChatDetails,
	ChatHistoryQuery,
	PlacedChat,
	ToolApprovers,
} from "@sugabots/contracts";
import { DEFAULT_CHAT_HISTORY_LIMIT } from "@sugabots/contracts";
import type { InvalidCursor } from "@sugabots/contracts/errors/chat-reads";
import { ResourceHidden } from "@sugabots/contracts/errors/proofs";
import { and, eq, type SQLWrapper, sql } from "drizzle-orm";
import { Context, DateTime, Effect, Layer } from "effect";
import { membersReachingProject } from "../authorization/access.ts";
import { type BotFacts, mayOnBot } from "../authorization/permissions.ts";
import { type Executor, query, serviceOperations } from "../database/database.ts";
import type * as schema from "../database/schema.ts";
import { automation, chatCompaction, member, placedChat, turn } from "../database/schema.ts";
import {
	type MemberPlace,
	mayInProjectAs,
	memberActing,
	type ProjectFacts,
} from "../proofs/facts.ts";
import type { ReachesChat } from "../proofs/reaches-chat.ts";
import { processLayer, Tier } from "../tiers.ts";
import { automationFailing, resultPosted, runBotFactsOf, toRun } from "./automations/execution.ts";
import { compactionLineTokens } from "./compaction/window.ts";
import { type CursorPoint, earlierThan, encodeCursor, parseCursor } from "./cursor.ts";
import {
	authorRow,
	botColumns,
	type MemberIdentity,
	memberColumns,
	memberJson,
	messageFromRelations,
	messageRelations,
	toMember,
	toParticipant,
} from "./store/participants.ts";
import { Turns } from "./turns/turns.ts";

/**
 * What the chat screens show of a chat an operation has proved its principal
 * reaches: the chat with its messages, and how much of its bot's context
 * window it fills.
 */
export interface Interface {
	/**
	 * The chat `reach` is about, with a page of its messages, and what the
	 * member acting may decide of its approvals: nothing, for a principal
	 * acting for no member.
	 */
	readonly get: <P, C>(
		reach: ReachesChat<P, C>,
		history?: ChatHistoryQuery,
	) => Effect.Effect<ChatDetails, ResourceHidden | InvalidCursor>;
	/** How much of its bot's context window the chat fills; null until a reply in it has been measured. */
	readonly context: <P, C>(
		reach: ReachesChat<P, C>,
	) => Effect.Effect<ChatContext | null, ResourceHidden>;
}

export class Service extends Context.Service<Service, Interface>()(
	"@sugabots/core/ChatDetailsView",
) {
	declare readonly [Tier]: "process";
}

export const make = Effect.gen(function* () {
	const operation = yield* serviceOperations<Interface>("ChatDetailsView");
	return Service.of({
		get: (reach, history = { limit: DEFAULT_CHAT_HISTORY_LIMIT }) =>
			operation(
				"get",
				Effect.gen(function* () {
					const chatId = reach.chat.value;
					yield* Effect.annotateCurrentSpan("chat.id", chatId);
					// Before anything is looked up, so a bad cursor says nothing about the chat.
					const before = history.cursor ? yield* parseCursor(history.cursor) : undefined;
					const row = yield* query((db) =>
						loadChat(db, { chatId, workspaceId: reach.workspace }, history.limit, before),
					);
					if (!row) return yield* new ResourceHidden({ resource: "chat" });
					const details = toChatDetails(row, memberActing(reach.as), reach.project, history.limit);
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

		context: (reach) =>
			operation(
				"context",
				Effect.gen(function* () {
					const [row] = yield* query((db) =>
						db
							.select({
								measured: latestMeasurementOf(placedChat.id),
								compactedAt: chatCompaction.updatedAt,
							})
							.from(placedChat)
							.leftJoin(chatCompaction, eq(chatCompaction.chatId, placedChat.id))
							.where(
								and(
									eq(placedChat.id, reach.chat.value),
									eq(placedChat.workspaceId, reach.workspace),
								),
							),
					);
					if (!row) return yield* new ResourceHidden({ resource: "chat" });
					return row.measured === null ? null : toChatContext(row.measured, row.compactedAt);
				}),
			),
	});
});

export const layerNoDeps = processLayer(Layer.effect(Service, make));

export const layer = layerNoDeps;

/**
 * The chat `chat.chatId` in its workspace, a page of its messages with their authors and the parts
 * placed in them, its participants, its project's bots and the members who reach
 * its project: one statement.
 */
const loadChat = Effect.fn("ChatDetailsView.loadChat")(function* (
	db: Executor,
	chat: { chatId: string; workspaceId: string },
	limit: number,
	before: CursorPoint | undefined,
) {
	return yield* db.query.placedChat.findFirst({
		where: { id: chat.chatId, workspaceId: chat.workspaceId },
		extras: {
			working: (row) => Turns.busyIn(sql`${row.id}`),
			queuedSince: (row) => Turns.queuedSince(sql`${row.id}`),
			// Who decides the approvals of a run turns on the run's bot.
			runBot: (row) => runBotFactsOf(row.id),
			// Not the project's members: a bot's default project has none, and the
			// floor reads mentions of everyone who reaches the project.
			membersReachingProject: (row) => sql<MemberIdentity[]>`(
				select coalesce(json_agg(${memberJson} order by ${member.name}), '[]'::json)
				from ${member}
				where ${member.id} in (${membersReachingProject(sql`${row.projectId}`)})
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
				with: { member: memberColumns, bot: botColumns },
			},
			reads: {
				columns: { readThrough: true, updatedAt: true },
				with: { member: memberColumns },
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
 * The chat as `viewer` sees it, the member acting, with the facts of the
 * project its reach was proved from.
 */
function toChatDetails(
	row: Chat,
	viewer: MemberPlace | undefined,
	project: ProjectFacts,
	limit: number,
): ChatDetails {
	const page = row.messages.slice(0, limit).reverse();
	const oldest = page[0];
	return {
		chat: toPlacedChat(row, row.working),
		// What this member may do with the approvals this chat raises, decided
		// once here so the chat does not have to work it out from a role.
		permissions: {
			approveToolCalls: mayDecideIn(viewer, project, row.runBot ?? undefined, "chat"),
			approveComputerRequests: mayDecideIn(viewer, project, undefined, "computer-managers"),
		},
		// A run is always listed in its automation's feed.
		automationRun:
			row.automationRun && row.rootChatId
				? toRun(row.automationRun, row.rootChatId, row.automationRun.posted)
				: null,
		participants: row.participants.map(({ member, bot: participant }) =>
			toParticipant(authorRow(member, participant)),
		),
		projectBots: (row.project?.bots ?? []).map((bot): BotParticipant => ({ kind: "bot", ...bot })),
		membersReachingProject: row.membersReachingProject.map(toMember),
		messages: page.map((stored) => messageFromRelations(stored, stored.turn)),
		olderMessagesCursor:
			row.messages.length > limit && oldest
				? encodeCursor({ at: oldest.createdAt, id: oldest.id })
				: null,
		queuedSince: row.queuedSince,
		reads: row.reads.map((read) => ({
			member: toMember(read.member),
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

/** A turn's prompt size, the window it was read with (unset on a system bot's turn), and when. */
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

function toPlacedChat(row: schema.PlacedChatRow, working: boolean): PlacedChat {
	return {
		id: row.id,
		workspaceId: row.workspaceId,
		projectId: row.projectId,
		botId: row.botId,
		rootChatId: row.rootChatId,
		kind: row.kind,
		title: row.title,
		working,
		resolvedAt: row.resolvedAt?.toISOString() ?? null,
		createdAt: row.createdAt.toISOString(),
		updatedAt: row.updatedAt.toISOString(),
	};
}

/**
 * Whether `viewer` may decide the approvals of a kind the chat raises, by the
 * rule the Approvals page selects them by (`mayDecideToolCall` in
 * `authorization/access.ts`), with their place in its project: a computer's
 * requests by those who decide them there; any other call by those who
 * decide approvals there, and in a run, who also manage `runBot`, the bot
 * doing it. A principal acting for no member decides nothing.
 */
function mayDecideIn(
	viewer: MemberPlace | undefined,
	project: ProjectFacts,
	runBot: BotFacts | undefined,
	approvers: ToolApprovers,
): boolean {
	if (!viewer) return false;
	if (approvers === "computer-managers") {
		return mayInProjectAs(viewer, project, "computer.request.decide");
	}
	if (!mayInProjectAs(viewer, project, "approval.decide")) return false;
	return runBot === undefined || mayOnBot(viewer.actor, "approval.automation.decide", runBot);
}
