import {
	type BotParticipant,
	type ConversationDetails,
	type ConversationKind,
	decideFloor,
	type Floor,
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
 * The bots the message being written goes to, where the person chooses them:
 * those the draft names, the bot replied to, and the bots the person's last
 * message went to, which stay addressed until they take them off: talking to
 * a bot is a conversation, not a mention every time. Taking one off lasts
 * until they send again. Where the person does not choose, there are none.
 */
export function useChatRecipients({
	userId,
	projectId,
	conversationId,
	choosesBots,
	projectBots: allProjectBots,
	shownMessages,
	draft,
	setDraft,
	replyingTo,
}: {
	userId: string;
	projectId: string | null;
	conversationId: string;
	/** Whether the person chooses which bots answer here; see `choosesBotsIn`. */
	choosesBots: boolean;
	/** The project's bots, when the conversation has loaded. */
	projectBots: readonly BotParticipant[] | undefined;
	shownMessages: readonly Message[];
	draft: string;
	setDraft: Dispatch<SetStateAction<string>>;
	replyingTo: MessageReplyTo | undefined;
}): ChatRecipients {
	const projectBots = choosesBots ? (allProjectBots ?? []) : [];
	const lastOwnMessage = choosesBots
		? shownMessages.findLast(
				(message) => message.author.kind === "person" && message.author.id === userId,
			)
		: undefined;
	const [takenOff, setTakenOff] = useTakenOffRecipients(userId, projectId, conversationId);
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
 * Whether the person chooses which bots answer a message in `details`: in a
 * project's thread with more than its lead bot, as the floor gives each bot a
 * message names, or replies to, its turn. With the lead alone, as in a bot's own
 * threads, the lead answers whichever it is, so there is nothing to choose;
 * and in an automation's feed only the lead ever answers.
 */
export function choosesBotsIn(
	details: Pick<ConversationDetails, "conversation" | "projectBots"> | undefined,
): boolean {
	return details?.conversation.kind === "project_thread" && details.projectBots.length > 1;
}

/**
 * Who answers the message being written, by the floor's rule (`decideFloor`),
 * as the server decides it once the message is sent:
 * - `bots`: in a thread, the project's bots the message mentions, else the one
 *   it replies to; each must reply.
 * - `lead`: the project's lead bot, which must reply.
 * - `leadMayReply`: in a thread, the draft mentions only people, so the lead reads
 *   it and either replies or reacts 👀.
 * - `leadWontReply`: in an automation's feed, the draft mentions only people.
 * - `nobody`: no bot answers. In a feed, because the project has no lead; in a
 *   thread, because it has no lead and the draft mentions and replies to none of
 *   its bots, or because the draft mentions only people and the lead has no model
 *   to reply with; and in any other conversation.
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
	/** Whether the draft mentions people and none of the project's bots. */
	peopleOnly: boolean;
	floor: DraftFloor;
}

/**
 * Whom `draft` mentions among `mentionable`, and who answers it in a
 * conversation of `conversationKind`.
 */
export function draftAudience({
	draft,
	conversationKind,
	mentionable,
	projectBots,
	lead,
	leadHasModel,
	chosen,
	replyingTo,
}: {
	draft: string;
	conversationKind: ConversationKind;
	mentionable: readonly Participant[];
	/** The project's bots: the only bots a mention or a reply gives a turn. */
	projectBots: readonly BotParticipant[];
	lead: BotParticipant | undefined;
	/** Whether `lead` has a model, without which it takes no optional turn. */
	leadHasModel: boolean;
	/** The bots the person chose (see `useChatRecipients`), which the message is sent mentioning. */
	chosen: readonly BotParticipant[];
	/** The message the draft replies to. */
	replyingTo: MessageReplyTo | undefined;
}): DraftAudience {
	const handles = mentionedHandles(draft);
	const mentions = mentionable.filter((member) => handles.includes(member.handle));
	const peopleOnly = mentionsOnlyPeople(handles, {
		botHandles: new Set(projectBots.map((bot) => bot.handle)),
		peopleHandles: new Set(
			mentionable.filter((one) => one.kind === "person").map((person) => person.handle),
		),
	});
	const mentionedBots = [...chosen, ...botsNamed(draft, projectBots)].filter(
		(bot, index, all) => all.findIndex((one) => one.id === bot.id) === index,
	);
	const repliedTo = botRepliedTo(replyingTo, projectBots);
	const floor = decideFloor({
		conversationKind,
		lead: lead ? { id: lead.id, hasModel: leadHasModel } : null,
		mentionedBotIds: mentionedBots.map((bot) => bot.id),
		repliedToProjectBotId: repliedTo?.id,
		peopleOnly,
	});
	return {
		mentions,
		peopleOnly,
		floor: draftFloorOf(floor, {
			conversationKind,
			lead,
			peopleOnly,
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
		conversationKind,
		lead,
		peopleOnly,
		bots,
	}: {
		conversationKind: ConversationKind;
		lead: BotParticipant | undefined;
		/** Whether the draft mentions only people. */
		peopleOnly: boolean;
		/** The bots the draft mentions or replies to. */
		bots: readonly BotParticipant[];
	},
): DraftFloor {
	if (floor.kind === "nobody") {
		return conversationKind === "automation_feed" && peopleOnly && lead
			? { kind: "leadWontReply", lead }
			: { kind: "nobody" };
	}
	const reason = floor.bots[0]?.reason;
	if (lead && reason === "optional") return { kind: "leadMayReply", lead };
	// In an automation's feed only the lead answers, whether the draft mentions it or not.
	if (lead && (reason === "default" || conversationKind === "automation_feed")) {
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
	return projectBots.find((member) => member.id === author.id);
}

/** `draft` with its mentions of `handle` taken out, each with the space after it. */
function withoutMention(draft: string, handle: string): string {
	return draft.replace(new RegExp(`${mentionPattern(handle)} ?`, "gi"), "");
}
