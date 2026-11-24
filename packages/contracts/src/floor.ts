import type { ChatKind } from "./messages.ts";

const nobody: Floor = { kind: "nobody" };

/**
 * Who has the floor: which bots, if any, answer a member's message (GLOSSARY.md's
 * "Floor"). The server decides it once the message is sent and asks for the
 * turns; the composer decides it for the draft, to say who will answer and to
 * hold Send while a bot that must answer has no model. Members post in two kinds
 * of chat:
 *
 * - A project's chat (`project_chat`), the same rule in every project, a
 *   bot's default project included:
 *   1. Mentioning the project's bots: each of them, taking a turn at once.
 *   2. Otherwise, replying to the message of one of the project's bots: that bot.
 *   3. Otherwise, mentioning only members: the lead bot reads it and may stay
 *      silent (an `optional` turn), as it may well be for them alone; a lead
 *      with no model takes no such turn, which could only fail.
 *   4. Otherwise the lead bot.
 *   Mentions of bots outside the project are ignored, so in a bot's own
 *   chats, where it is the only bot, only it ever answers.
 * - An automation's feed (`automation_feed`), in the automation's project:
 *   1. Mentioning only members: nobody.
 *   2. Otherwise the project's lead bot, which runs the automation, whichever
 *      bots the member mentions: mentions bring in no other bot.
 *
 * A bot's message has its own rule, `helpersAskedBy`.
 */
export function decideFloor(message: AddressedMessage): Floor {
	switch (message.chatKind) {
		case "project_chat":
			return projectChatFloor(message);
		case "automation_feed": {
			const { lead } = message;
			if (lead === null || message.membersOnly) return nobody;
			return turnFor(lead.id, message.mentionedBotIds.includes(lead.id) ? "mention" : "default");
		}
		default:
			return nobody;
	}
}

/** What the floor is decided from, of a member's message and the chat it is in. */
export interface AddressedMessage {
	chatKind: ChatKind;
	/**
	 * The project's lead bot, and whether it has a model, without which it is not
	 * offered a turn it may decline. Null outside a project.
	 */
	lead: { id: string; hasModel: boolean } | null;
	/** The project's bots the message mentions, each once; bots outside the project don't count. */
	mentionedBotIds: readonly string[];
	/** The project's bot that wrote the message this one replies to, if one did. */
	repliedToProjectBotId: string | undefined;
	/** Whether the message mentions only members; see `mentionsOnlyMembers`. */
	membersOnly: boolean;
}

/** Why a bot was given the floor; see `decideFloor`. */
type FloorTurnReason = "mention" | "reply" | "default" | "optional";

/** The bots that take a turn after a member's message, each with why, or that none does. */
export type Floor =
	| { kind: "turns"; bots: Array<{ botId: string; reason: FloorTurnReason }> }
	| { kind: "nobody" };

function projectChatFloor(message: AddressedMessage): Floor {
	if (message.mentionedBotIds.length > 0) {
		return {
			kind: "turns",
			bots: message.mentionedBotIds.map((botId) => ({ botId, reason: "mention" })),
		};
	}
	if (message.repliedToProjectBotId !== undefined) {
		return turnFor(message.repliedToProjectBotId, "reply");
	}
	const { lead } = message;
	if (lead === null) return nobody;
	if (!message.membersOnly) return turnFor(lead.id, "default");
	return lead.hasModel ? turnFor(lead.id, "optional") : nobody;
}

function turnFor(botId: string, reason: FloorTurnReason): Floor {
	return { kind: "turns", bots: [{ botId, reason }] };
}

/**
 * Which bots a bot's message asks for help, each taking a turn in the chat as
 * its helper (GLOSSARY.md's "Collaboration"): the only way a bot's message
 * gives another bot a turn, apart from a brief, so bots can't keep each other
 * talking. The project's other bots it mentions, unless:
 *
 * - the turn that wrote it may not ask: a helper's own mentions start no turn,
 *   so collaborations go one deep;
 * - the chat is not a project's chat or a run's: in an automation's feed a
 *   bot's mentions bring in no bot, as a member's don't;
 * - the bot was already asked for the same member's message, brief or run, by
 *   an earlier message of the asking bot's: a hand-back asks only bots not yet
 *   asked.
 *
 * A bot's mention of itself asks nobody. Mentions of bots outside the project
 * are not in `mentionedBotIds`, so in a bot's own chats it has nobody to ask.
 */
export function helpersAskedBy(message: AskingMessage): string[] {
	if (!message.mayAsk) return [];
	if (message.chatKind !== "project_chat" && message.chatKind !== "run") return [];
	return message.mentionedBotIds.filter(
		(botId) => botId !== message.authorBotId && !message.alreadyAsked.has(botId),
	);
}

/** What `helpersAskedBy` decides from, of a bot's message and the chat it is in. */
export interface AskingMessage {
	chatKind: ChatKind;
	/** The bot that wrote it. */
	authorBotId: string;
	/**
	 * Whether the turn that wrote it may ask for help: one answering a member's
	 * message, a brief or a run, or a hand-back; not a helper's.
	 */
	mayAsk: boolean;
	/** The project's bots the message mentions, each once. */
	mentionedBotIds: readonly string[];
	/** The bots already asked for the same member's message, brief or run. */
	alreadyAsked: ReadonlySet<string>;
}
