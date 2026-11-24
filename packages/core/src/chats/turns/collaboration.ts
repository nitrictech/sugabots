import { and, desc, eq, inArray, sql } from "drizzle-orm";
import { Effect } from "effect";
import type { Executor } from "../../database/database.ts";
import { ACTIVE_TURN_STATUSES, message, type TurnReason, turn } from "../../database/schema.ts";
import { heldInLane } from "./turn.workflow.ts";

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
 * The turn a helper's or a hand-back's asking message `askingMessageId`
 * goes back to: the one answering a member's message, a brief or a run that
 * started its chain, with why it was taken and the member who wrote the
 * message it answers, if a member did. A helper and a hand-back act for that
 * turn's asker, or its run. Undefined when the message was not written by a
 * turn.
 */
export const turnAskingFor = Effect.fn("Collaboration.turnAskingFor")(function* (
	db: Executor,
	askingMessageId: string,
) {
	const [row] = yield* db.execute<{ reason: TurnReason | null; asker_id: string | null }>(
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
		select asking.reason, answered.author_member_id as asker_id
		from asking join ${message} as answered on answered.id = asking.trigger_message_id
		order by asking.depth desc
		limit 1`,
		"objects",
	);
	return row && { reason: row.reason, askerId: row.asker_id };
});

/**
 * The newest message a turn on `triggerMessageId` for `reason` reads the chat
 * up to: for a helper, the asking message, so it reads what it was asked;
 * for a hand-back, the last of its helpers' replies. Undefined for any other
 * turn, which reads everything posted before it starts.
 */
export const readsUpTo = Effect.fn("Collaboration.readsUpTo")(function* (
	db: Executor,
	request: { triggerMessageId: string; reason: TurnReason },
) {
	if (request.reason === "collaboration") return request.triggerMessageId;
	if (request.reason !== "hand_back") return undefined;
	const [lastReply] = yield* db
		.select({ id: message.id })
		.from(message)
		.innerJoin(turn, eq(turn.id, message.turnId))
		.where(
			and(eq(turn.triggerMessageId, request.triggerMessageId), eq(turn.reason, "collaboration")),
		)
		.orderBy(desc(message.createdAt), desc(message.id))
		.limit(1);
	return lastReply?.id ?? request.triggerMessageId;
});

/**
 * Whether the bot `asking.botId` is owed its hand-back on its message
 * `asking.messageId` in the chat `asking.chatId`: some helper took a turn on
 * it, none is still working or waiting to start, and the hand-back has not
 * been asked for. `endedHelperBotId` is a helper whose turn the caller's
 * transaction ended, whose lane is still held while its workflow finishes.
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
	const [row] = yield* db.execute<{ owed: boolean }>(
		sql`select (
			exists (select 1 from ${turn} where ${helperTurns})
			and not exists (
				select 1 from ${turn}
				where ${helperTurns} and ${inArray(turn.status, [...ACTIVE_TURN_STATUSES])}
			)
			and not ${heldInLane(asking.chatId, {
				triggerMessageId: asking.messageId,
				reason: "collaboration",
				...(endedHelperBotId !== undefined && { exceptBotId: endedHelperBotId }),
			})}
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
