export * as ConversationView from "./conversation-view.ts";

import type {
	BotParticipant,
	ConversationActivity,
	ConversationContext,
	ConversationDetails,
	ConversationHistoryQuery,
	PlacedConversation,
} from "@sugabots/contracts";
import { DEFAULT_CONVERSATION_HISTORY_LIMIT } from "@sugabots/contracts";
import { userText } from "@sugabots/errors";
import { and, eq, type SQLWrapper, sql } from "drizzle-orm";
import { Context, Data, DateTime, Effect, Layer } from "effect";
import {
	type ConversationStanding,
	computerProjectStandingFor,
	mayDecideToolCall,
	peopleReachingProject,
	ResourceHidden,
} from "../authorization/access.ts";
import { CurrentActor } from "../authorization/current-actor.ts";
import { Visibility } from "../authorization/visibility.ts";
import { type Executor, query, serviceOperations } from "../database/database.ts";
import type * as schema from "../database/schema.ts";
import {
	automation,
	conversationCompaction,
	placedConversation,
	turn,
	user,
} from "../database/schema.ts";
import { isUuid } from "../ids/ids.ts";
import type { UserFacing } from "../user-message.ts";
import { automationFailing, resultPosted, runIdOf, toRun } from "./automations/execution.ts";
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
} from "./repository/participants.ts";
import { Turns } from "./turns/turns.ts";

/**
 * What the conversation screens show, of the conversations the current actor can see: a
 * conversation with its messages, and its sidebar.
 */
export interface Interface {
	readonly get: (
		conversationId: string,
		history?: ConversationHistoryQuery,
	) => Effect.Effect<
		ConversationDetails,
		ResourceHidden | InvalidConversationHistoryCursor,
		CurrentActor.Service
	>;
	/** What the conversation's sidebar shows. */
	readonly activity: (
		conversationId: string,
	) => Effect.Effect<ConversationActivity, ResourceHidden, CurrentActor.Service>;
}

export class Service extends Context.Service<Service, Interface>()(
	"@sugabots/core/ConversationView",
) {}

export const make = Effect.gen(function* () {
	const operation = yield* serviceOperations<Interface>("ConversationView");
	const visibility = yield* Visibility.Service;
	return Service.of({
		get: (conversationId, history = { limit: DEFAULT_CONVERSATION_HISTORY_LIMIT }) =>
			operation(
				"get",
				Effect.gen(function* () {
					yield* Effect.annotateCurrentSpan("conversation.id", conversationId);
					// Before anything is looked up, and whether or not the conversation is there,
					// so a bad cursor says nothing about the conversation.
					const before = history.cursor ? yield* historyCursor(history.cursor) : undefined;
					const standing = yield* visibility.conversationStanding(conversationId);
					const row = yield* query((db) =>
						loadConversation(db, standing.conversation.id, history.limit, before),
					);
					if (!row) return yield* new ResourceHidden({ resource: "conversation" });
					const computerDeciders = yield* computerRequestDecidersIn(row, standing);
					const details = toConversationDetails(row, standing, computerDeciders, history.limit);
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

		activity: (conversationId) =>
			operation(
				"activity",
				Effect.gen(function* () {
					if (!isUuid(conversationId))
						return yield* new ResourceHidden({ resource: "conversation" });
					const reachesConversation = yield* visibility.reachesConversation;
					const [row] = yield* query((db) =>
						db
							.select({
								measured: latestMeasurementOf(placedConversation.id),
								compactedAt: conversationCompaction.updatedAt,
							})
							.from(placedConversation)
							.leftJoin(
								conversationCompaction,
								eq(conversationCompaction.conversationId, placedConversation.id),
							)
							.where(
								and(
									eq(placedConversation.id, conversationId),
									reachesConversation(placedConversation),
								),
							),
					);
					if (!row) return yield* new ResourceHidden({ resource: "conversation" });
					return {
						context:
							row.measured === null ? null : toConversationContext(row.measured, row.compactedAt),
					};
				}),
			),
	});
});

export const layerNoDeps = Layer.effect(Service, make);

export const layer = layerNoDeps.pipe(Layer.provide(Visibility.layer));

export class InvalidConversationHistoryCursor
	extends Data.TaggedError("InvalidConversationHistoryCursor")
	implements UserFacing
{
	get userMessage() {
		return userText`That conversation history cursor is invalid`;
	}
}

/**
 * The conversation `conversationId`, a page of its messages with their authors and the parts
 * placed in them, its participants, its project's bots and the people who reach
 * its project: one statement.
 */
const loadConversation = Effect.fn("ConversationView.loadConversation")(function* (
	db: Executor,
	conversationId: string,
	limit: number,
	before: CursorPoint | undefined,
) {
	return yield* db.query.placedConversation.findFirst({
		where: { id: conversationId },
		extras: {
			running: (row) => Turns.busyIn(sql`${row.id}`),
			queuedSince: (row) => Turns.queuedSince(sql`${row.id}`),
			runId: (row) => runIdOf(row.id),
			// Not the project's members: a bot's default project has none, and the
			// floor reads mentions of everyone who reaches the project.
			peopleReachingProject: (row) => sql<PersonIdentity[]>`(
				select coalesce(json_agg(${personJson} order by ${user.name}), '[]'::json)
				from ${user}
				where ${user.id} in (${peopleReachingProject(sql`${row.projectId}`)})
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
				with: { user: personColumns, bot: botColumns },
			},
			reads: {
				columns: { readThrough: true, updatedAt: true },
				with: { user: personColumns },
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

type Conversation = NonNullable<Effect.Success<ReturnType<typeof loadConversation>>>;

/**
 * The bots that speak in the conversation, its own and any taking part, whose
 * requests to change the computer they work on the caller may decide: those
 * who manage that computer's project, the conversation's, or in a
 * collaboration the bot's own default project. Outside a collaboration every
 * bot works on the conversation's project, in which the caller's `standing`
 * is already known.
 */
const computerRequestDecidersIn = Effect.fn("ConversationView.computerRequestDecidersIn")(
	function* (row: Conversation, standing: ConversationStanding) {
		const speakers = new Set(
			[row.botId, ...row.participants.map(({ bot: participant }) => participant?.id)].filter(
				(id): id is string => typeof id === "string",
			),
		);
		if (row.kind !== "collaboration") {
			const managesComputer = standing.standing.may("computer.request.decide");
			return managesComputer ? [...speakers] : [];
		}
		const { userId } = yield* CurrentActor.Service;
		const deciding: string[] = [];
		for (const botId of speakers) {
			const standing = yield* query((db) => computerProjectStandingFor(db, row.id, botId, userId));
			if (standing?.may("computer.request.decide")) deciding.push(botId);
		}
		return deciding;
	},
);

function toConversationDetails(
	row: Conversation,
	standing: ConversationStanding,
	computerDeciders: readonly string[],
	limit: number,
): ConversationDetails {
	const inAutomation = row.runId !== null;
	const page = row.messages.slice(0, limit).reverse();
	const oldest = page[0];
	return {
		conversation: toPlacedConversation(row, row.running),
		// What this person may do with the approvals this conversation raises, decided
		// once here so the conversation does not have to work it out from a role.
		capabilities: {
			approveToolCalls: mayDecideToolCall(
				standing.standing,
				undefined,
				inAutomation,
				"conversation",
			),
			approveComputerRequestsOf: computerDeciders,
		},
		// A run is always listed in its automation's feed.
		automationRun:
			row.automationRun && row.rootConversationId
				? toRun(row.automationRun, row.rootConversationId, row.automationRun.posted)
				: null,
		participants: row.participants.map(({ user: person, bot: participant }) =>
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
			person: toPerson(read.user),
			readThrough: read.readThrough.toISOString(),
			// Written whenever they read further, so when they last did.
			readAt: read.updatedAt.toISOString(),
		})),
	};
}

/**
 * How many tokens the prompt of the conversation's latest measured turn took,
 * the window it was read with, and when. Its own turns only: the Compaction
 * bot's are in a system conversation of its own.
 */
const latestMeasurementOf = (conversationId: SQLWrapper) => sql<Measurement | null>`(
	select json_build_object('tokens', ${turn.contextTokens}, 'window', ${turn.contextCapacity}, 'at', coalesce(${turn.finishedAt}, ${turn.createdAt}))
	from ${turn}
	where ${turn.conversationId} = ${conversationId} and ${turn.contextTokens} is not null
	order by ${turn.createdAt} desc
	limit 1
)`;

/** A turn's prompt size, the window it was read with (unset on older turns), and when. */
interface Measurement {
	tokens: number;
	window: number | null;
	at: string;
}

/** The context the conversation's latest measured turn used, against the window that turn read with. */
function toConversationContext(
	measured: Measurement,
	compactedAt: Date | null,
): ConversationContext {
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
	return point ? Effect.succeed(point) : Effect.fail(new InvalidConversationHistoryCursor());
};

function toPlacedConversation(
	row: schema.PlacedConversationRow,
	running: boolean,
): PlacedConversation {
	return {
		id: row.id,
		workspaceId: row.workspaceId,
		projectId: row.projectId,
		botId: row.botId,
		rootConversationId: row.rootConversationId,
		kind: row.kind,
		title: row.title,
		status: running ? "running" : "done",
		parentConversationId: row.parentConversationId,
		doneAt: row.doneAt?.toISOString() ?? null,
		createdAt: row.createdAt.toISOString(),
		updatedAt: row.updatedAt.toISOString(),
	};
}
