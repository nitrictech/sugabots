import { uuidSchema } from "@sugabots/contracts/uuid";

export * as TurnRequests from "./requests.ts";

import { and, asc, eq, type SQL, sql } from "drizzle-orm";
import { Context, Effect, Schema, SchemaGetter } from "effect";
import { query } from "../../database/database.ts";
import { Tier } from "../../tiers.ts";
import { Lanes } from "../../workflows/lanes.ts";
import { lane, laneRequest } from "../../workflows/sql.ts";
import { type TurnReason, turn } from "../sql.ts";

/**
 * Asking for a bot's turn. Core decides when a turn is asked for and how it
 * queues in its lane; the bot loop owns the workflow that runs it, so it
 * starts the workflow. Core declares this service and the server provides it
 * from the bot loop, so core starts turns without knowing the bot loop.
 */
export interface Interface {
	/**
	 * Asks for the turn `request` names in its lane, joining the caller's
	 * transaction; the turn starts once that commits. Says whether it started,
	 * waits, or joined a turn already waiting (see {@link admission}).
	 */
	readonly ask: (request: TurnRequest) => Effect.Effect<Lanes.Admission>;
}

export class Service extends Context.Service<Service, Interface>()("@sugabots/core/TurnRequests") {
	declare readonly [Tier]: "process";
}

/** The name of the workflow that runs a turn, under which its lanes hold it. */
export const TURN_WORKFLOW = "turn";

/**
 * A hand-back as the workflows started before hand-backs had their name
 * stored it, `resume`, so one still running decodes as a hand-back. Its
 * execution id leaves the reason out, so it stays the same.
 */
const HandBackStoredAsResume = Schema.Literal("resume").pipe(
	Schema.decodeTo(Schema.Literal("hand_back"), {
		decode: SchemaGetter.transform(() => "hand_back" as const),
		encode: SchemaGetter.transform(() => "resume" as const),
	}),
);

/** The turn a workflow carries out, as its payload: which bot answers which message in which chat, and why. */
export const TurnRequest = Schema.Struct({
	chatId: uuidSchema,
	botId: uuidSchema,
	triggerMessageId: uuidSchema,
	reason: Schema.Union([
		Schema.Literals([
			"mention",
			"reply",
			"default",
			"optional",
			"collaboration",
			"automation",
			"hand_back",
			"interview",
			"brief",
		]),
		HandBackStoredAsResume,
	]) satisfies Schema.Codec<TurnReason, TurnReason | "resume">,
	/**
	 * The member the turn acts for, worked out when it is asked for (see
	 * `askerOfMessage`), so its lane can tell whose turns may join. Null for a
	 * turn that acts for no member, such as a run's; absent on a helper's
	 * turn, a hand-back, and requests stored before it was kept, none of
	 * which joins another.
	 */
	askerId: Schema.optional(Schema.NullOr(Schema.String)),
});
export type TurnRequest = typeof TurnRequest.Type;

/** A turn is one bot answering one message, so that is what identifies the workflow running it. */
export const executionKey = (request: TurnRequest) =>
	`${request.chatId}/${request.botId}/${request.triggerMessageId}`;

/** One turn per bot per chat at a time; the turn reads everything posted while it waited. */
export const turnLane = (request: Pick<TurnRequest, "chatId" | "botId">) =>
	`turn:${request.chatId}:${request.botId}`;

/**
 * Whether a turn for `reason` answers its own message alone: a helper's,
 * asked by another bot's message, and a hand-back, asked once the helpers are
 * done. Such a turn never joins another waiting for its bot, and nothing joins
 * it, so a member's message can't make a helper the bot answering a member.
 */
export const answersAlone = (reason: TurnReason): boolean =>
	reason === "collaboration" || reason === "hand_back";

/**
 * How the turn `request` queues in its lane. It joins a turn already waiting
 * for the same member, which reads its asker's messages posted before it
 * starts; otherwise it waits behind every turn there, so one member's message
 * never becomes part of a turn that acts for another. Neither a turn that
 * answers its own message alone (see `answersAlone`) nor one for no member
 * joins or is joined.
 */
export const admission = (request: TurnRequest) => ({
	key: turnLane(request),
	subject: request.chatId,
	whenBusy: joinsWaiting(request) ? ("coalesce" as const) : ("queue" as const),
	joins: (waiting: TurnRequest) => joinsWaiting(waiting) && waiting.askerId === request.askerId,
});

/** Whether the turn `request` may join, or be joined by, another waiting for the same member. */
const joinsWaiting = (request: TurnRequest): request is TurnRequest & { askerId: string } =>
	!answersAlone(request.reason) && typeof request.askerId === "string";

/**
 * Whether the lanes of the chat `chatId` hold a turn for `reason` on the
 * message `triggerMessageId`, not yet started, running, or ended with its lane
 * not yet free; when `botMatches` is given, only one whose bot's id, as text,
 * it matches. As a condition for a query.
 */
export const heldInLane = (
	chatId: string,
	turn: { triggerMessageId: string; reason: TurnReason },
	botMatches?: (botId: SQL) => SQL | undefined,
) =>
	// Every field of a `TurnRequest` is a string, so its JSON encoding names them as it does.
	Lanes.holdsRequest(sql`${chatId}`, TURN_WORKFLOW, (payload) =>
		and(
			sql`${payload}->>'triggerMessageId' = ${turn.triggerMessageId}`,
			sql`${payload}->>'reason' = ${turn.reason}`,
			botMatches?.(sql`${payload}->>'botId'`),
		),
	);

/**
 * Holds the opening of the bot `request.botId`'s turns in the chat
 * `request.chatId` until the caller's transaction ends, and says which turn its
 * lane runs: none when it is idle, and whether that turn has opened. Opening a
 * turn holds the same (see `TurnStore.openReplyTurn`), so a message deciding
 * whether to join a turn not yet opened, or to steer it once it has, sees it
 * one way or the other, never in between.
 *
 * An advisory lock rather than the lane's row: ending a turn locks its row and
 * then may ask for a turn in its lane, which locks the lane's row, so a steer
 * locking the lane's row before the turn's could deadlock with it.
 */
export const holdOpening = (request: Pick<TurnRequest, "chatId" | "botId">) =>
	Effect.gen(function* () {
		yield* lockOpening(request);
		const [held] = yield* query((db) =>
			db
				.select({ state: lane.state, workflow: lane.workflow, payload: lane.payload })
				.from(lane)
				.where(eq(lane.key, turnLane(request))),
		);
		if (!held || held.state === "idle" || held.workflow !== TURN_WORKFLOW) return undefined;
		const running = Schema.decodeUnknownSync(Schema.toCodecJson(TurnRequest))(held.payload);
		const [opened] = yield* query((db) =>
			db
				.select({ id: turn.id })
				.from(turn)
				.where(
					and(eq(turn.triggerMessageId, running.triggerMessageId), eq(turn.botId, running.botId)),
				)
				.limit(1),
		);
		return { running, opened: opened !== undefined };
	});

/**
 * Whether the turn `request` asks for joins the turn `running`, which holds
 * its lane and has not opened yet: both answer the same member, as a turn
 * waiting to start would be joined (see `admission`). The running turn then
 * reads its message as one that joined it (see `Collaboration.joinedTurn`).
 */
export const joinsUnopened = (request: TurnRequest, running: TurnRequest) =>
	admission(request).whenBusy === "coalesce" && admission(request).joins(running);

/** Holds the opening of the bot `request.botId`'s turns in its chat until the transaction ends (see `holdOpening`). */
export const lockOpening = (request: Pick<TurnRequest, "chatId" | "botId">) =>
	query((db) =>
		db.execute(
			sql`select pg_advisory_xact_lock(hashtextextended(${`turn-opening:${turnLane(request)}`}, 0))`,
		),
	).pipe(Effect.asVoid);

/**
 * The turn waiting in the lane of `request` that acts for the member
 * `askerId`, which a request of theirs joins (see `admission`): at most one
 * waits, as each later one joins it.
 */
export const waitingFor = (request: Pick<TurnRequest, "chatId" | "botId">, askerId: string) =>
	Effect.map(
		query((db) =>
			db
				.select({ payload: laneRequest.payload })
				.from(laneRequest)
				.where(
					and(
						eq(laneRequest.laneKey, turnLane(request)),
						sql`${laneRequest.payload}->>'askerId' = ${askerId}`,
					),
				)
				.orderBy(asc(laneRequest.createdAt), asc(laneRequest.id))
				.limit(1),
		),
		([waiting]) =>
			waiting && Schema.decodeUnknownSync(Schema.toCodecJson(TurnRequest))(waiting.payload),
	);
