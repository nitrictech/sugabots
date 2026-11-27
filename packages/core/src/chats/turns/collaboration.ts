import {
	and,
	asc,
	desc,
	eq,
	inArray,
	notInArray,
	type SQL,
	type SQLWrapper,
	sql,
} from "drizzle-orm";
import { Effect } from "effect";
import type { Executor, QueryFailure } from "../../database/database.ts";
import {
	ACTIVE_TURN_STATUSES,
	bot,
	type JoinedTurn,
	message,
	type TurnReason,
	turn,
} from "../../database/schema.ts";
import { lane, laneRequest } from "../../workflows/sql.ts";
import { heldInLane, TURN_WORKFLOW } from "./requests.ts";

/**
 * What turns read of collaborations (GLOSSARY.md's "Collaboration"): a bot
 * asking another of its project's bots, its helper, for help by mentioning it
 * in a reply. The helper answers that reply, the **asking message**, in a turn
 * of its own (`collaboration`). Once every helper's turn has ended, the
 * asking bot takes one more turn on the asking message, its hand-back
 * (`hand_back`), which may ask again, and so on: each asking message is
 * written by the turn answering a member's message, a brief or a run, or by
 * a hand-back, whose own asking message is the one before it in the chain.
 */

/**
 * The bots already asked for help for the same member's message, brief or
 * run as the asking message `messageId`: those whose turns answer it or an
 * earlier asking message of its chain.
 */
export const botsAskedBefore = Effect.fn("Collaboration.botsAskedBefore")(function* (
	db: Executor,
	messageId: string,
) {
	const rows = yield* db.execute<{ bot_id: string }>(
		sql`with recursive asking (message_id, turn_id) as (
			select ${message.id}, ${message.turnId} from ${message} where ${message.id} = ${messageId}
			union all
			select earlier.id, earlier.turn_id
			from asking
			join ${turn} on ${turn.id} = asking.turn_id and ${turn.reason} = ${"hand_back" satisfies TurnReason}
			join ${message} as earlier on earlier.id = ${turn.triggerMessageId}
		)
		select distinct ${turn.botId} as bot_id from ${turn}
		where ${turn.reason} = ${"collaboration" satisfies TurnReason}
			and ${turn.triggerMessageId} in (select message_id from asking)`,
		"objects",
	);
	return new Set(rows.map((row) => row.bot_id));
});

/**
 * Why the turn a helper's or a hand-back's asking message `askingMessageId`
 * goes back to was taken: the one answering a member's message, a brief or a
 * run that started its chain. Undefined when the message was not written by a
 * turn.
 */
export const turnAskingFor = Effect.fn("Collaboration.turnAskingFor")(function* (
	db: Executor,
	askingMessageId: string,
) {
	const [row] = yield* db.execute<{ reason: TurnReason | null }>(
		sql`with recursive asking (turn_id, reason, trigger_message_id, depth) as (
			select ${turn.id}, ${turn.reason}, ${turn.triggerMessageId}, 0
			from ${message} join ${turn} on ${turn.id} = ${message.turnId}
			where ${message.id} = ${askingMessageId}
			union all
			select earlier.id, earlier.reason, earlier.trigger_message_id, asking.depth + 1
			from asking
			join ${message} as written on written.id = asking.trigger_message_id
			join ${turn} as earlier on earlier.id = written.turn_id
			where asking.reason = ${"hand_back" satisfies TurnReason}
		)
		select asking.reason
		from asking
		order by asking.depth desc
		limit 1`,
		"objects",
	);
	return row && { reason: row.reason };
});

/** A turn, as `readingLimitOf` reads its limit. */
interface ReadingTurn {
	readonly turnId: string;
	readonly chatId: string;
	readonly botId: string;
	readonly triggerMessageId: string;
	readonly reason: TurnReason;
}

/**
 * How far the turn `reading` reads the chat (see `ReadingLimit`), so a
 * message someone else posts later can't steer it, even through its bot's
 * reply to it. It reads up to the latest message it answers: for a helper,
 * the message that mentioned it; for any other turn, the latest of its
 * asker's messages that joined it, or the one it was asked for. A hand-back
 * reads what the turn that asked for help read, plus its helpers' replies to
 * the message that asked. A turn reads its asker's steers apart, as they reach
 * it. Undefined for a hand-back whose asking message no turn wrote, or with no
 * helper's turn on it, as when a migration moved its helpers' replies into the
 * chat, which reads it all.
 */
export const readingLimitOf = (
	db: Executor,
	reading: ReadingTurn,
): Effect.Effect<ReadingLimit | undefined, QueryFailure> =>
	Effect.gen(function* () {
		if (reading.reason === "collaboration") {
			return { upTo: reading.triggerMessageId, ownBotId: reading.botId };
		}
		if (reading.reason === "hand_back") {
			const [asking] = yield* db
				.select({
					turnId: turn.id,
					chatId: turn.chatId,
					botId: turn.botId,
					triggerMessageId: turn.triggerMessageId,
					reason: turn.reason,
				})
				.from(message)
				.innerJoin(turn, eq(turn.id, message.turnId))
				.where(eq(message.id, reading.triggerMessageId))
				.limit(1);
			if (!asking?.reason || asking.turnId === reading.turnId) return undefined;
			// No helper's turn on the asking message, as when a migration moved
			// the helpers' replies into the chat: it reads them all.
			const [helper] = yield* db
				.select({ id: turn.id })
				.from(turn)
				.where(
					and(
						eq(turn.triggerMessageId, reading.triggerMessageId),
						eq(turn.reason, "collaboration"),
					),
				)
				.limit(1);
			if (!helper) return undefined;
			const read = yield* readingLimitOf(db, { ...asking, reason: asking.reason });
			return read && { ...read, helpersOf: reading.triggerMessageId };
		}
		const joined: JoinedTurn = { botId: reading.botId, triggerMessageId: reading.triggerMessageId };
		const [latest] = yield* db
			.select({ id: message.id })
			.from(message)
			.where(
				and(
					eq(message.chatId, reading.chatId),
					sql`${message.joinedTurns} @> ${JSON.stringify([joined])}::jsonb`,
				),
			)
			.orderBy(desc(message.createdAt), desc(message.id))
			.limit(1);
		return { upTo: latest?.id ?? reading.triggerMessageId, ownBotId: reading.botId };
	});

/**
 * How far a turn reads the chat: up to the message `upTo`, plus the replies
 * its own bot `ownBotId` wrote to what it reads, and on a hand-back, its
 * helpers' replies to the asking message `helpersOf`.
 */
export interface ReadingLimit {
	readonly upTo: string;
	readonly ownBotId: string;
	readonly helpersOf?: string;
}

/**
 * Whether the message `row` is within `limit`, as a condition for a query: no
 * later in its chat than `limit.upTo`, in the order the chat shows them; a
 * reply of the reading turn's bot to a message no later than that; or on a
 * hand-back, a helper's reply to its asking message.
 */
export const withinReadingLimit = (
	row: { createdAt: SQLWrapper; id: SQLWrapper; authorBotId: SQLWrapper; turnId: SQLWrapper },
	limit: ReadingLimit,
) => {
	const upTo = sql`(select ${message.createdAt}, ${message.id} from ${message} where ${message.id} = ${limit.upTo})`;
	const helpers = limit.helpersOf
		? sql`exists (
			select 1 from ${turn} as helping
			where helping.id = ${row.turnId}
				and helping.reason = ${"collaboration" satisfies TurnReason}
				and helping.trigger_message_id = ${limit.helpersOf}
		)`
		: sql`false`;
	return sql`((${row.createdAt}, ${row.id}) <= ${upTo}
		or (${row.authorBotId} = ${limit.ownBotId} and exists (
			select 1 from ${turn} as replying
			inner join ${message} as answered on answered.id = replying.trigger_message_id
			where replying.id = ${row.turnId}
				and (answered.created_at, answered.id) <= ${upTo}
		))
		or ${helpers})`;
};

/**
 * The helpers whose turns on the asking message `askingMessageId` ended
 * without replying, failed or interrupted, by name, for the hand-back to be
 * told: what members were told of a failure is `error`.
 */
export const helpersWithoutReply = Effect.fn("Collaboration.helpersWithoutReply")(function* (
	db: Executor,
	askingMessageId: string,
) {
	return yield* db
		.select({ name: bot.name, handle: bot.handle, status: turn.status, error: turn.error })
		.from(turn)
		.innerJoin(bot, eq(bot.id, turn.botId))
		.where(
			and(
				eq(turn.triggerMessageId, askingMessageId),
				eq(turn.reason, "collaboration"),
				inArray(turn.status, ["failed", "cancelled"]),
			),
		)
		.orderBy(asc(bot.name), asc(bot.id));
});

/**
 * Whether the bot `asking.botId` is owed its hand-back on its message
 * `asking.messageId` in the chat `asking.chatId`: some helper took a turn on
 * it, every helper asked on it has ended for good, and the hand-back has not
 * been asked for. Asked in the transaction that ends the last helper's turn,
 * so the hand-back's lane holds the chat busy from the moment nothing else
 * does, and an automation run can't settle in between.
 *
 * A helper has ended for good once its turn is done, cancelled, or failed
 * and not retrying; its lane, still held while its workflow finishes, then
 * counts for nothing. One with no turn yet is still to start while a lane
 * holds its request, other than `endedHelperBotId`'s: a helper whose turn
 * the caller's transaction gives up on before it opened, whose lane is held
 * until its workflow finishes. So is a retrying one, until its lane is free.
 */
export const handBackOwed = Effect.fn("Collaboration.handBackOwed")(function* (
	db: Executor,
	asking: { chatId: string; messageId: string; botId: string },
	endedHelperBotId: string | undefined,
) {
	const helperTurns = and(
		eq(turn.triggerMessageId, asking.messageId),
		eq(turn.reason, "collaboration"),
	);
	const endedForGood = (helperBotId: SQL) => sql`exists (
		select 1 from ${turn}
		where ${turn.triggerMessageId} = ${asking.messageId}
			and ${turn.botId}::text = ${helperBotId}
			and ${notInArray(turn.status, [...ACTIVE_TURN_STATUSES])}
			and not ${turn.retrying}
	)`;
	const [row] = yield* db.execute<{ owed: boolean }>(
		sql`select (
			exists (select 1 from ${turn} where ${helperTurns})
			and not exists (
				select 1 from ${turn}
				where ${helperTurns} and ${inArray(turn.status, [...ACTIVE_TURN_STATUSES])}
			)
			and not ${heldInLane(
				asking.chatId,
				{ triggerMessageId: asking.messageId, reason: "collaboration" },
				(helperBotId) =>
					and(
						sql`not ${endedForGood(helperBotId)}`,
						endedHelperBotId === undefined ? undefined : sql`${helperBotId} <> ${endedHelperBotId}`,
					),
			)}
			and not exists (
				select 1 from ${turn}
				where ${turn.triggerMessageId} = ${asking.messageId} and ${turn.botId} = ${asking.botId}
			)
			and not ${heldInLane(asking.chatId, { triggerMessageId: asking.messageId, reason: "hand_back" })}
		) as owed`,
		"objects",
	);
	return row?.owed ?? false;
});

/**
 * The earliest message a turn in the chat `chatId` still answers, running,
 * waiting for approvals or to run again, or asked for in a lane: what no
 * compaction may condense, or reach past, so a turn never reads later
 * messages condensed. A helper's and a hand-back's count as the turn that
 * asked for help, whose reading they follow, back through every hand-back
 * that asked again to the message that started them. Undefined when no turn
 * is to come.
 */
export const earliestAnsweredByTurnToCome = Effect.fn("Collaboration.earliestAnsweredByTurnToCome")(
	function* (db: Executor, chatId: string) {
		const [earliest] = yield* db.execute<{ id: string }>(
			sql`with recursive to_come(trigger_id) as (
				select ${turn.triggerMessageId} from ${turn}
				where ${turn.chatId} = ${chatId}
					and (${inArray(turn.status, [...ACTIVE_TURN_STATUSES])} or ${turn.retrying})
				union all
				select (${lane.payload}->>'triggerMessageId')::uuid from ${lane}
				where ${lane.subject} = ${chatId} and ${lane.workflow} = ${TURN_WORKFLOW} and ${lane.state} <> 'idle'
				union all
				select (waiting.payload->>'triggerMessageId')::uuid
				from ${laneRequest} as waiting
				join ${lane} on ${lane.key} = waiting.lane_key
				where ${lane.subject} = ${chatId} and waiting.workflow = ${TURN_WORKFLOW}
			), answered(id) as (
				select trigger_id from to_come
				union
				select asking.trigger_message_id
				from answered
				join ${message} as written on written.id = answered.id and written.author_bot_id is not null
				join ${turn} as asking on asking.id = written.turn_id
			)
			select ${message.id} as id
			from answered join ${message} on ${message.id} = answered.id
			order by ${message.createdAt}, ${message.id}
			limit 1`,
			"objects",
		);
		if (!earliest) return undefined;
		const [found] = yield* db
			.select({ id: message.id, createdAt: message.createdAt })
			.from(message)
			.where(eq(message.id, earliest.id))
			.limit(1);
		return found;
	},
);
