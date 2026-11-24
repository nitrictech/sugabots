/**
 * What a turn acts for, read from its rows: the turn authenticator builds its
 * principal from these, and the provers that ask who a turn's asker is, or
 * whose approval its calls wait for, read the same facts.
 *
 * The asker isn't stored with the turn. It is the member who wrote the
 * message the turn answers; when a bot wrote that message in another turn,
 * as a helper's question or a hand-back's, it is that turn's asker, and so on
 * back. A message a bot wrote outside any turn, such as a brief, or a turn's
 * own reply, such as an interview's first, acts for the member who started
 * its chat. A run's own turns answer the message its automation's trigger
 * posted.
 */

import type { RunTriggerKind } from "@sugabots/contracts";
import { eq, sql } from "drizzle-orm";
import { alias } from "drizzle-orm/pg-core";
import { Effect } from "effect";
import type { Executor } from "../database/database.ts";
import {
	automationRun,
	bot,
	message,
	placedChat,
	project,
	projectChat,
	type TurnReason,
	type TurnStatus,
	turn,
} from "../database/schema.ts";
import { isUuid } from "../ids/ids.ts";

export interface TurnFacts {
	readonly turn: string;
	readonly chat: string;
	readonly workspace: string;
	readonly bot: string;
	readonly status: TurnStatus;
	readonly reason: TurnReason | null;
	/** The project the turn's chat is in; none for a chat in no project, such as a system chat. */
	readonly project: string | null;
	/** Whether the turn's chat is one of its bot's own chats, in the bot's default project. */
	readonly inOwnChats: boolean;
	/** On a Personal Assistant: its member. */
	readonly assistantOf: string | null;
	/** The run whose chat the turn is in, if it is in one. */
	readonly run: {
		readonly run: string;
		readonly automation: string;
		/** The bot that does the run, whose managers approve its calls. */
		readonly bot: string;
		readonly startedBy: RunTriggerKind;
	} | null;
	/** What the message the turn answers comes back to, followed back through the turns that wrote it. */
	readonly askedBy: AskedBy;
	/** Whether a Personal Assistant wrote the brief this turn answers. */
	readonly briefedByAssistant: boolean;
}

/**
 * Who the message a turn answers comes from: a member, its automation's
 * trigger, or neither, when the chain of turns behind it ends nowhere else.
 */
export type AskedBy =
	| { readonly kind: "member"; readonly member: string }
	| { readonly kind: "automation" }
	| { readonly kind: "nobody" };

/**
 * How many turns back an asker is followed. A helper's question goes one back
 * and a hand-back's two; anything deeper is a chain no rule makes.
 */
const MAX_ASKING_TURNS = 8;

const triggerMessage = alias(message, "trigger_message");
const triggerAuthorBot = alias(bot, "trigger_author_bot");

/** The facts of the turn `turnId`, or `undefined` when there is no such turn. */
export const turnFacts = (db: Executor, turnId: string) =>
	Effect.gen(function* () {
		if (!isUuid(turnId)) return undefined;
		const [row] = yield* db
			.select({
				turn: turn.id,
				chat: turn.chatId,
				bot: turn.botId,
				status: turn.status,
				reason: turn.reason,
				workspace: placedChat.workspaceId,
				project: placedChat.projectId,
				defaultOfBot: project.defaultOfBotId,
				assistantOf: bot.assistantOf,
				run: automationRun.id,
				automation: automationRun.automationId,
				runBot: automationRun.botId,
				runStartedBy: automationRun.triggerKind,
				triggerAuthorAssistantOf: triggerAuthorBot.assistantOf,
			})
			.from(turn)
			.innerJoin(placedChat, eq(placedChat.id, turn.chatId))
			.innerJoin(bot, eq(bot.id, turn.botId))
			.leftJoin(project, eq(project.id, placedChat.projectId))
			.leftJoin(automationRun, eq(automationRun.chatId, turn.chatId))
			.leftJoin(triggerMessage, eq(triggerMessage.id, turn.triggerMessageId))
			.leftJoin(triggerAuthorBot, eq(triggerAuthorBot.id, triggerMessage.authorBotId))
			.where(eq(turn.id, turnId))
			.limit(1);
		if (!row) return undefined;
		const facts: TurnFacts = {
			turn: row.turn,
			chat: row.chat,
			workspace: row.workspace,
			bot: row.bot,
			status: row.status,
			reason: row.reason,
			project: row.project,
			inOwnChats: row.defaultOfBot === row.bot,
			assistantOf: row.assistantOf,
			run:
				row.run && row.automation && row.runBot && row.runStartedBy
					? {
							run: row.run,
							automation: row.automation,
							bot: row.runBot,
							startedBy: row.runStartedBy,
						}
					: null,
			askedBy: yield* askedByOf(db, turnId),
			briefedByAssistant: row.reason === "brief" && row.triggerAuthorAssistantOf !== null,
		};
		return facts;
	});

/** The member a turn acts for: whoever asked it, or for a Personal Assistant's run, its member. */
export function askerOf(facts: TurnFacts): string | undefined {
	switch (facts.askedBy.kind) {
		case "member":
			return facts.askedBy.member;
		case "automation":
			return facts.run && runActsForMember(facts) ? (facts.assistantOf ?? undefined) : undefined;
		case "nobody":
			return undefined;
	}
}

/** Whether the turn's run is a Personal Assistant's, which acts for its member. */
function runActsForMember(facts: TurnFacts): boolean {
	return facts.assistantOf !== null && facts.inOwnChats;
}

/** Follows the message `turnId` answers back through the turns that wrote it. */
const askedByOf = (db: Executor, turnId: string) =>
	Effect.gen(function* () {
		const [end] = yield* db.execute<{
			author_member_id: string | null;
			automation: boolean;
			written_in_turn: string | null;
			answered_by_turn: string;
			started_by_id: string | null;
		}>(
			sql`with recursive asking(depth, turn_id, message_id) as (
				select 0, asked.id, asked.trigger_message_id
				from ${turn} as asked
				where asked.id = ${turnId}
				union all
				select asking.depth + 1, earlier.id, earlier.trigger_message_id
				from asking
				inner join ${message} as asking_message on asking_message.id = asking.message_id
				inner join ${turn} as earlier on earlier.id = asking_message.turn_id
				where asking_message.author_bot_id is not null
					and earlier.id <> asking.turn_id
					and asking.depth < ${MAX_ASKING_TURNS}
			)
			select
				end_message.author_member_id,
				end_message.automation_trigger is not null as automation,
				end_message.turn_id as written_in_turn,
				asking.turn_id as answered_by_turn,
				end_chat.started_by_id
			from asking
			inner join ${message} as end_message on end_message.id = asking.message_id
			left join ${projectChat} as end_chat on end_chat.chat_id = end_message.chat_id
			order by asking.depth desc
			limit 1`,
			"objects",
		);
		if (!end) return { kind: "nobody" } as const;
		if (end.author_member_id) return { kind: "member", member: end.author_member_id } as const;
		if (end.automation) return { kind: "automation" } as const;
		// A bot's message the chain can't follow further: one written outside any
		// turn, or the answering turn's own reply. Deeper than the limit is neither.
		const writtenOutsideAnother =
			end.written_in_turn === null || end.written_in_turn === end.answered_by_turn;
		return writtenOutsideAnother && end.started_by_id
			? ({ kind: "member", member: end.started_by_id } as const)
			: ({ kind: "nobody" } as const);
	});
