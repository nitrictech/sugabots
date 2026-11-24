import {
	type BotParticipant,
	type ChatDetails,
	type ChatKind,
	decideFloor,
	type Floor,
	type Message,
	type MessageReplyTo,
	mentionedHandles,
	mentionPattern,
	mentionsOnlyMembers,
	type Participant,
} from "@sugabots/contracts";
import type { Dispatch, SetStateAction } from "react";
import { useTakenOffRecipients } from "@/lib/chat-draft.ts";
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
 * The bots the message being written goes to, where the member chooses them:
 * those the draft names, the bot replied to, and the bots the member's last
 * message went to, which stay addressed until they take them off: talking to
 * a bot is a chat, not a mention every time. Taking one off lasts
 * until they send again. Where the member does not choose, there are none.
 */
export function useChatRecipients({
	memberId,
	chatId,
	choosesBots,
	projectBots: allProjectBots,
	shownMessages,
	draft,
	setDraft,
	replyingTo,
}: {
	memberId: string;
	chatId: string;
	/** Whether the member chooses which bots answer here; see `choosesBotsIn`. */
	choosesBots: boolean;
	/** The project's bots, when the chat has loaded. */
	projectBots: readonly BotParticipant[] | undefined;
	shownMessages: readonly Message[];
	draft: string;
	setDraft: Dispatch<SetStateAction<string>>;
	replyingTo: MessageReplyTo | undefined;
}): ChatRecipients {
	const projectBots = choosesBots ? (allProjectBots ?? []) : [];
	const lastOwnMessage = choosesBots
		? shownMessages.findLast(
				(message) => message.author.kind === "member" && message.author.id === memberId,
			)
		: undefined;
	const [takenOff, setTakenOff] = useTakenOffRecipients(memberId, chatId);
	const takenOffIds = takenOff.after === lastOwnMessage?.id ? takenOff.botIds : [];
	const named = botsNamed(draft, projectBots);
	const repliedToBot = botRepliedTo(replyingTo, projectBots);
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
		answering: [
			...named,
			...addressed,
			...(repliedToBot && !named.some((one) => one.id === repliedToBot.id) ? [repliedToBot] : []),
		],
		remove: (bot) => {
			setDraft((current) => withoutMention(current, bot.handle));
			takeOff([bot.id]);
		},
		clearAddressed: () => takeOff(addressed.map((bot) => bot.id)),
	};
}

/**
 * Whether the member chooses which bots answer a message in `details`: in a
 * project's chat with more than its lead bot, as the floor gives each bot a
 * message names, or replies to, its turn. With the lead alone, as in a bot's own
 * chats, the lead answers whichever it is, so there is nothing to choose;
 * and in an automation's feed only the lead ever answers.
 */
export function choosesBotsIn(
	details: Pick<ChatDetails, "chat" | "projectBots"> | undefined,
): boolean {
	return details?.chat.kind === "project_chat" && details.projectBots.length > 1;
}

/**
 * Who answers the message being written, by the floor's rule (`decideFloor`),
 * as the server decides it once the message is sent:
 * - `bots`: in a chat, the project's bots the message mentions, else the one
 *   it replies to; each must reply.
 * - `lead`: the project's lead bot, which must reply.
 * - `leadMayReply`: in a chat, the draft mentions only members, so the lead reads
 *   it and either replies or reacts 👀.
 * - `leadWontReply`: in an automation's feed, the draft mentions only members.
 * - `nobody`: no bot answers. In a chat, because the draft mentions only
 *   members and the lead has no model to reply with; and in any other
 *   chat.
 */
export type DraftFloor =
	| { kind: "bots"; bots: BotParticipant[] }
	| { kind: "lead"; lead: BotParticipant }
	| { kind: "leadMayReply"; lead: BotParticipant }
	| { kind: "leadWontReply"; lead: BotParticipant }
	| { kind: "nobody" };

/** Whom the draft mentions, and who answers it; see `draftAudience`. */
export interface DraftAudience {
	/** Everyone here the draft mentions. */
	mentions: Participant[];
	/** Whether the draft mentions members and none of the project's bots. */
	membersOnly: boolean;
	floor: DraftFloor;
}

/**
 * Whom `draft` mentions among `mentionable`, and who answers it in a
 * chat of `chatKind`.
 */
export function draftAudience({
	draft,
	chatKind,
	mentionable,
	projectBots,
	lead,
	leadHasModel,
	chosen,
	replyingTo,
}: {
	draft: string;
	chatKind: ChatKind;
	mentionable: readonly Participant[];
	/** The project's bots: the only bots a mention or a reply gives a turn. */
	projectBots: readonly BotParticipant[];
	lead: BotParticipant | undefined;
	/** Whether `lead` has a model, without which it takes no optional turn. */
	leadHasModel: boolean;
	/** The bots the member chose (see `useChatRecipients`), which the message is sent mentioning. */
	chosen: readonly BotParticipant[];
	/** The message the draft replies to. */
	replyingTo: MessageReplyTo | undefined;
}): DraftAudience {
	const handles = mentionedHandles(draft);
	const mentions = mentionable.filter((participant) => handles.includes(participant.handle));
	const membersOnly = mentionsOnlyMembers(handles, {
		botHandles: new Set(projectBots.map((bot) => bot.handle)),
		membersHandles: new Set(
			mentionable.filter((one) => one.kind === "member").map((member) => member.handle),
		),
	});
	const mentionedBots = [...chosen, ...botsNamed(draft, projectBots)].filter(
		(bot, index, all) => all.findIndex((one) => one.id === bot.id) === index,
	);
	const repliedTo = botRepliedTo(replyingTo, projectBots);
	const floor = decideFloor({
		chatKind,
		lead: lead ? { id: lead.id, hasModel: leadHasModel } : null,
		mentionedBotIds: mentionedBots.map((bot) => bot.id),
		repliedToProjectBotId: repliedTo?.id,
		membersOnly,
	});
	return {
		mentions,
		membersOnly,
		floor: draftFloorOf(floor, {
			chatKind,
			lead,
			membersOnly,
			bots: [...mentionedBots, ...(repliedTo ? [repliedTo] : [])],
		}),
	};
}

/** The bots that must reply to the draft, which the server refuses it for if any has no model. */
export function requiredRepliers(floor: DraftFloor): BotParticipant[] {
	if (floor.kind === "bots") return floor.bots;
	if (floor.kind === "lead") return [floor.lead];
	return [];
}

/** `floor` as the composer shows it, with each bot it names among `bots` or the `lead`. */
function draftFloorOf(
	floor: Floor,
	{
		chatKind,
		lead,
		membersOnly,
		bots,
	}: {
		chatKind: ChatKind;
		lead: BotParticipant | undefined;
		/** Whether the draft mentions only members. */
		membersOnly: boolean;
		/** The bots the draft mentions or replies to. */
		bots: readonly BotParticipant[];
	},
): DraftFloor {
	if (floor.kind === "nobody") {
		return chatKind === "automation_feed" && membersOnly && lead
			? { kind: "leadWontReply", lead }
			: { kind: "nobody" };
	}
	const reason = floor.bots[0]?.reason;
	if (lead && reason === "optional") return { kind: "leadMayReply", lead };
	// In an automation's feed only the lead answers, whether the draft mentions it or not.
	if (lead && (reason === "default" || chatKind === "automation_feed")) {
		return { kind: "lead", lead };
	}
	return {
		kind: "bots",
		bots: floor.bots.flatMap(({ botId }) => {
			const bot = bots.find((one) => one.id === botId);
			return bot ? [bot] : [];
		}),
	};
}

/** The bots among `projectBots` that `message` went to: those it names, and the one it replied to. */
function botsAddressedBy(
	message: Message,
	projectBots: readonly BotParticipant[],
): BotParticipant[] {
	const named = botsNamed(message.content, projectBots);
	const repliedTo = botRepliedTo(message.replyTo, projectBots);
	return repliedTo && !named.some((bot) => bot.id === repliedTo.id) ? [...named, repliedTo] : named;
}

/** The bot among `projectBots` that wrote the message `replyTo` answers, if a bot of theirs did. */
function botRepliedTo(
	replyTo: MessageReplyTo | undefined,
	projectBots: readonly BotParticipant[],
): BotParticipant | undefined {
	const author = replyTo?.author;
	if (author?.kind !== "bot") return undefined;
	return projectBots.find((bot) => bot.id === author.id);
}

/** `draft` with its mentions of `handle` taken out, each with the space after it. */
function withoutMention(draft: string, handle: string): string {
	return draft.replace(new RegExp(`${mentionPattern(handle)} ?`, "gi"), "");
}
