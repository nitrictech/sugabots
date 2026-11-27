import type { TurnBounds } from "../principal.ts";
/**
 * What a turn acts for, read from its rows: the turn authenticator builds its
 * principal from these, and the provers that ask who a turn's asker is, or
 * whose approval its calls wait for, read the same facts.
 *
 * The asker is stored with the turn when it is made (see `askerColumns`):
 * the member who wrote the message the turn answers; when a bot wrote that
 * message in another turn, as a helper's question or a hand-back's, that
 * turn's asker. A message a bot wrote outside any turn, such as a brief, acts
 * for the member who started its chat, and so does an interview's turn, which
 * answers its own first reply. A run's own turns answer the message its
 * automation's trigger posted, and a personal bot's act for its creator.
 */

import type { RunTriggerKind } from "@sugabots/contracts";
import { eq, sql } from "drizzle-orm";
import { alias } from "drizzle-orm/pg-core";
import { Effect } from "effect";
import { personalBotCreator } from "../authorization/permissions.ts";
import type { Executor } from "../database/database.ts";
import {
	automationRun,
	type BriefTurnRule,
	bot,
	message,
	placedChat,
	project,
	type TurnReason,
	type TurnStatus,
	turn,
} from "../database/schema.ts";
import { isUuid } from "../ids/ids.ts";
import type { TurnAdmission } from "../principal.ts";

export interface TurnFacts {
	readonly turn: string;
	readonly chat: string;
	readonly workspace: string;
	readonly bot: string;
	readonly status: TurnStatus;
	readonly retrying: boolean;
	readonly admission: TurnAdmission | null;
	readonly reason: TurnReason | null;
	/** The project the turn's chat is in; none for a chat in no project, such as a system chat. */
	readonly project: string | null;
	/** Whether the turn's chat is one of its bot's own chats, in the bot's default project. */
	readonly inOwnChats: boolean;
	/** On a personal bot: its creator, whose permissions it acts with. */
	readonly personalBotCreator: string | null;
	/** The run whose chat the turn is in, if it is in one. */
	readonly run: {
		readonly run: string;
		readonly automation: string;
		/** The bot that does the run, whose managers approve its calls. */
		readonly bot: string;
		readonly startedBy: RunTriggerKind;
	} | null;
	/** Who the turn was recorded as acting for when it was made. */
	readonly askedBy: AskedBy;
	/** Whether a personal bot wrote the brief this turn answers. */
	readonly briefedByPersonalBot: boolean;
	readonly briefTurnRule: BriefTurnRule | null;
}

/**
 * Who the message a turn answers comes from: a member; its automation's
 * trigger, with the member its run acts for, a personal bot's creator; or
 * neither, when the chain of turns behind it ends nowhere else.
 */
type AskedBy =
	| { readonly kind: "member"; readonly member: string }
	| { readonly kind: "automation"; readonly member: string | null }
	| { readonly kind: "nobody" };

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
				retrying: turn.retrying,
				admission: turn.admission,
				reason: turn.reason,
				askerId: turn.askerId,
				askedByAutomation: turn.askedByAutomation,
				workspace: placedChat.workspaceId,
				project: placedChat.projectId,
				defaultOfBot: project.defaultOfBotId,
				visibility: bot.visibility,
				createdBy: bot.createdById,
				run: automationRun.id,
				automation: automationRun.automationId,
				runBot: automationRun.botId,
				runStartedBy: automationRun.triggerKind,
				triggerAuthorVisibility: triggerAuthorBot.visibility,
				briefTurnRule: triggerMessage.briefTurnRule,
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
			retrying: row.retrying,
			admission: row.admission,
			reason: row.reason,
			project: row.project,
			inOwnChats: row.defaultOfBot === row.bot,
			personalBotCreator: personalBotCreator({
				visibility: row.visibility,
				createdById: row.createdBy,
			}),
			run:
				row.run && row.automation && row.runBot && row.runStartedBy
					? {
							run: row.run,
							automation: row.automation,
							bot: row.runBot,
							startedBy: row.runStartedBy,
						}
					: null,
			askedBy: row.askedByAutomation
				? { kind: "automation", member: row.askerId }
				: row.askerId
					? { kind: "member", member: row.askerId }
					: { kind: "nobody" },
			briefedByPersonalBot: row.reason === "brief" && row.triggerAuthorVisibility === "personal",
			briefTurnRule: row.reason === "brief" ? row.briefTurnRule : null,
		};
		return facts;
	});

export function startedFromOutside(facts: TurnFacts) {
	return facts.run?.startedBy === "webhook" || facts.run?.startedBy === "github";
}

export function hasMemberBounds(facts: TurnFacts, asker = askerOf(facts)) {
	return (
		facts.personalBotCreator !== null &&
		facts.personalBotCreator === asker &&
		facts.inOwnChats &&
		(facts.reason !== "brief" || facts.briefTurnRule === "memberBounds") &&
		!startedFromOutside(facts)
	);
}

export function turnBounds(facts: TurnFacts, asker: string, project: string): TurnBounds {
	return hasMemberBounds(facts, asker) ? { kind: "member" } : { kind: "chat", project };
}

export function canWriteBrief(reason: TurnFacts["reason"]): boolean {
	return reason !== "collaboration" && reason !== "brief";
}

export function asksBeforeAllTools(facts: TurnFacts) {
	return (
		facts.briefTurnRule === "askBeforeAllTools" ||
		(facts.personalBotCreator !== null && facts.inOwnChats && startedFromOutside(facts))
	);
}

/** The member a turn acts for: whoever asked it, or for a personal bot's run, its creator. */
export function askerOf(facts: TurnFacts): string | undefined {
	return facts.askedBy.kind === "nobody" ? undefined : (facts.askedBy.member ?? undefined);
}

/**
 * Who the bot `botId`'s turn answering the message `triggerMessageId` in the
 * chat `chatId` acts for: the member who wrote the message; when a bot's turn
 * wrote it, as a helper's question or a hand-back's, that turn's asker, or its
 * run; when its automation's trigger posted it, its run, with no member but a
 * personal bot's, which acts for its creator in its own chats. A bot's
 * message no turn wrote, such as a brief, acts for the member who started its
 * chat, and so does an interview's turn, which answers its own first reply.
 *
 * The one definition, the database's `turn_asker`: worked out as a turn is
 * asked for, to key its lane, and stored as the turn is made (see
 * `askerColumns`).
 */
export const askerOfMessage = Effect.fn("TurnFacts.askerOfMessage")(function* (
	db: Executor,
	answering: Answering,
) {
	const [row] = yield* db.execute<{ member_id: string | null; automation: boolean }>(
		sql`select member_id, automation from ${turnAsker(answering)}`,
		"objects",
	);
	return { askerId: row?.member_id ?? null, automation: row?.automation ?? false };
});

/** A turn's place: the bot `botId` answering the message `triggerMessageId` in the chat `chatId`. */
export interface Answering {
	readonly chatId: string;
	readonly botId: string;
	readonly triggerMessageId: string;
}

/**
 * The asker columns of a turn as it is written (see `askerOfMessage`), for the
 * statement that makes it: whoever makes a turn row writes them, the turn
 * store and seeds alike.
 */
export const askerColumns = (answering: Answering) => ({
	askerId: sql<string | null>`(select member_id from ${turnAsker(answering)})`,
	askedByAutomation: sql<boolean>`(select automation from ${turnAsker(answering)})`,
});

const turnAsker = ({ chatId, botId, triggerMessageId }: Answering) =>
	sql`turn_asker(${chatId}::uuid, ${triggerMessageId}::uuid, ${botId}::uuid)`;
