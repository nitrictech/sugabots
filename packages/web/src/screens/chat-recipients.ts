import {
	type BotParticipant,
	type Message,
	type MessageReplyTo,
	mentionedHandles,
	mentionPattern,
	mentionsOnlyPeople,
	type Participant,
} from "@sugabots/contracts";
import type { Dispatch, SetStateAction } from "react";
import { useTakenOffRecipients } from "@/lib/conversation-draft.ts";
import { botsNamed } from "./mentions.tsx";

/** The bots the message being written goes to, and the ways to take them off; see `useChatRecipients`. */
export interface ChatRecipients {
	/** Those the draft names. */
	named: BotParticipant[];
	/** Those the last message went to, still addressed, that the draft does not name. */
	addressed: BotParticipant[];
	/** Everyone the message goes to: those named, those addressed, and the bot replied to. */
	answering: BotParticipant[];
	/** Takes `bot` off, wherever it came from: named in the draft, or addressed by the last message. */
	remove: (bot: BotParticipant) => void;
	/** Takes off every bot the last message went to. */
	clearAddressed: () => void;
}

/**
 * The bots the message being written goes to. Where named bots reply, as in
 * a project, the bots the person's last message went to stay addressed until
 * they take them off: talking to a bot is a conversation, not a mention every
 * time. Taking one off lasts until they send again. Elsewhere only the bots
 * the draft names, and the bot replied to, are counted.
 */
export function useChatRecipients({
	userId,
	projectId,
	conversationId,
	namedBotsReply,
	projectBots: allProjectBots,
	shownMessages,
	draft,
	setDraft,
	replyingTo,
}: {
	userId: string;
	projectId: string | null;
	conversationId: string;
	/** Whether the bots people name reply here, as in a project. */
	namedBotsReply: boolean;
	/** The project's bots, when the conversation has loaded. */
	projectBots: readonly Participant[] | undefined;
	shownMessages: readonly Message[];
	draft: string;
	setDraft: Dispatch<SetStateAction<string>>;
	replyingTo: MessageReplyTo | undefined;
}): ChatRecipients {
	const projectBots = namedBotsReply ? (allProjectBots ?? []) : [];
	const lastOwnMessage = namedBotsReply
		? shownMessages.findLast(
				(message) => message.author.kind === "person" && message.author.id === userId,
			)
		: undefined;
	const [takenOff, setTakenOff] = useTakenOffRecipients(userId, projectId, conversationId);
	const takenOffIds = takenOff.after === lastOwnMessage?.id ? takenOff.botIds : [];
	const named = botsNamed(draft, projectBots);
	const repliedToBot = projectBots.find(
		(member): member is BotParticipant =>
			member.kind === "bot" &&
			replyingTo?.author.kind === "bot" &&
			member.id === replyingTo.author.id,
	);
	const addressed = (lastOwnMessage ? botsAddressedBy(lastOwnMessage, projectBots) : []).filter(
		(bot) =>
			!takenOffIds.includes(bot.id) &&
			bot.id !== repliedToBot?.id &&
			!named.some((one) => one.id === bot.id),
	);
	function takeOff(botIds: readonly string[]) {
		setTakenOff({ after: lastOwnMessage?.id, botIds: [...takenOffIds, ...botIds] });
	}
	return {
		named,
		addressed,
		answering: [...named, ...addressed, ...(repliedToBot ? [repliedToBot] : [])],
		remove: (bot) => {
			setDraft((current) => withoutMention(current, bot.handle));
			takeOff([bot.id]);
		},
		clearAddressed: () => takeOff(addressed.map((bot) => bot.id)),
	};
}

/** Whom the draft mentions, and what that means for the conversation's own bot; see `draftAudience`. */
export interface DraftAudience {
	/** Everyone here the draft mentions. */
	mentions: Participant[];
	/** Whether the draft mentions only people, so the conversation's own bot does not reply. */
	botStaysOut: boolean;
	/** The other bots the draft mentions, whom the conversation's own bot asks for help. */
	askedForHelp: Participant[];
}

/**
 * Whom `draft` mentions among `mentionable`. A bot's conversation goes to its
 * bot, `host`, unless the message mentions only people.
 */
export function draftAudience(
	draft: string,
	mentionable: readonly Participant[],
	host: BotParticipant | undefined,
): DraftAudience {
	const handles = mentionedHandles(draft);
	const mentions = mentionable.filter((member) => handles.includes(member.handle));
	return {
		mentions,
		botStaysOut:
			host !== undefined &&
			mentionsOnlyPeople(handles, {
				botHandles: handlesOf(mentionable, "bot"),
				peopleHandles: handlesOf(mentionable, "person"),
			}),
		askedForHelp: mentions.filter((member) => member.kind === "bot" && member.id !== host?.id),
	};
}

/** The handles of those in `participants` who are bots (`"bot"`) or people (`"person"`). */
function handlesOf(participants: readonly Participant[], kind: Participant["kind"]): Set<string> {
	return new Set(participants.filter((one) => one.kind === kind).map((one) => one.handle));
}

/** The bots among `projectBots` that `message` went to: those it names, and the one it replied to. */
function botsAddressedBy(message: Message, projectBots: readonly Participant[]): BotParticipant[] {
	const named = botsNamed(message.content, projectBots);
	const repliedTo = message.replyTo?.author;
	const replied =
		repliedTo?.kind === "bot" && !named.some((bot) => bot.id === repliedTo.id)
			? projectBots.filter(
					(member): member is BotParticipant => member.kind === "bot" && member.id === repliedTo.id,
				)
			: [];
	return [...named, ...replied];
}

/** `draft` with its mentions of `handle` taken out, each with the space after it. */
function withoutMention(draft: string, handle: string): string {
	return draft.replace(new RegExp(`${mentionPattern(handle)} ?`, "gi"), "");
}
