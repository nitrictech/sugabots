import type { ChatKind } from "./messages.ts";

const nobody: Floor = { kind: "nobody" };

/**
 * Who has the floor: which bots, if any, answer a person's message (GLOSSARY.md's
 * "Floor"). The server decides it once the message is sent and asks for the
 * turns; the composer decides it for the draft, to say who will answer and to
 * hold Send while a bot that must answer has no model. People post in two kinds
 * of chat:
 *
 * - A project's chat (`project_chat`), the same rule in every project, a
 *   bot's default project included:
 *   1. Mentioning the project's bots: each of them, taking a turn at once.
 *   2. Otherwise, replying to the message of one of the project's bots: that bot.
 *   3. Otherwise, mentioning only people: the lead bot reads it and may stay
 *      silent (an `optional` turn), as it may well be for them alone; a lead
 *      with no model takes no such turn, which could only fail.
 *   4. Otherwise the lead bot.
 *   Mentions of bots outside the project are ignored, so in a bot's own
 *   chats, where it is the only bot, only it ever answers.
 * - An automation's feed (`automation_feed`), in the automation's project:
 *   1. Mentioning only people: nobody.
 *   2. Otherwise the project's lead bot, which runs the automation, whichever
 *      bots the person mentions: another bot they name is reached by the lead
 *      collaborating, not by joining.
 */
export function decideFloor(message: AddressedMessage): Floor {
	switch (message.chatKind) {
		case "project_chat":
			return projectChatFloor(message);
		case "automation_feed": {
			const { lead } = message;
			if (lead === null || message.peopleOnly) return nobody;
			return turnFor(lead.id, message.mentionedBotIds.includes(lead.id) ? "mention" : "default");
		}
		default:
			return nobody;
	}
}

/** What the floor is decided from, of a person's message and the chat it is in. */
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
	/** Whether the message mentions only people; see `mentionsOnlyPeople`. */
	peopleOnly: boolean;
}

/** Why a bot was given the floor; see `decideFloor`. */
type FloorTurnReason = "mention" | "reply" | "default" | "optional";

/** The bots that take a turn after a person's message, each with why, or that none does. */
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
	if (!message.peopleOnly) return turnFor(lead.id, "default");
	return lead.hasModel ? turnFor(lead.id, "optional") : nobody;
}

function turnFor(botId: string, reason: FloorTurnReason): Floor {
	return { kind: "turns", bots: [{ botId, reason }] };
}
