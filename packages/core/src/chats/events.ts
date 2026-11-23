import type {
	CollaborationPart,
	FilePart,
	Message,
	MessageReaction,
	PersonParticipant,
	ToolCallPart,
} from "@sugabots/contracts";
import type { UserText } from "@sugabots/errors";
import { Data } from "effect";
import type { Turns } from "./turns/turns.ts";

/**
 * What happened in a chat, as the facts that changed.
 *
 * The stores emit these through `DomainEvents` in the transaction that wrote
 * them; `ChatEventStream` decides what a watching client is told. An event carries
 * the ids involved and what changed, plus what the feed would otherwise have
 * to query back, such as a finished reply's content. A tool call or
 * collaboration is carried whole, as the chat shows it, because clients
 * replace the part rather than patch it. An event the workspace's lists hear
 * of carries its chat, so only people who reach the chat are told.
 */
export type ChatEvent = Data.TaggedEnum<{
	/** A message was posted whole: a person's, or an automation run's result. */
	MessagePosted: {
		readonly chatId: string;
		readonly workspaceId: string;
		readonly message: Message;
	};
	/** Somebody reacted to a message or took a reaction back. `reactions` is all it has now. */
	ReactionsChanged: {
		readonly chatId: string;
		readonly messageId: string;
		readonly reactions: readonly MessageReaction[];
	};
	/**
	 * A bot attached a file to its reply. `files` is all the reply carries
	 * now; a reply that starts again starts without them, as its `TurnStarted` says.
	 */
	MessageFilesChanged: {
		readonly chatId: string;
		readonly messageId: string;
		readonly files: readonly FilePart[];
	};
	/** Bots were brought into the chat to answer in it. */
	BotsJoined: { readonly chatId: string; readonly botIds: readonly string[] };
	/**
	 * A bot's turn was asked for while it was already answering in the
	 * chat, so it waits to start, and will read what was posted meanwhile.
	 */
	TurnQueued: { readonly chatId: string };
	/** A bot's turn opened, with its reply as an empty `writing` message. Not emitted when a suspended turn resumes. */
	TurnStarted: {
		readonly chatId: string;
		readonly workspaceId: string;
		readonly turnId: string;
		readonly botId: string;
		readonly reply: Message;
	};
	/** The turn finished and its reply is complete. */
	TurnCompleted: {
		readonly chatId: string;
		readonly workspaceId: string;
		readonly turnId: string;
		readonly botId: string;
		readonly messageId: string;
		readonly content: string;
		/** The prompt's size, and the window it was read with. */
		readonly contextTokens: number | undefined;
		readonly contextCapacity: number;
		/** Where the compaction the turn read from kept history from, if it read one. */
		readonly readKeptFrom: string | null;
	};
	/**
	 * The bot's optional turn ended with nothing to say, so it stayed silent:
	 * its empty reply `messageId` was taken back, and it reacted 👀 to the
	 * message it read instead.
	 */
	TurnStayedSilent: {
		readonly chatId: string;
		readonly workspaceId: string;
		readonly turnId: string;
		readonly botId: string;
	};
	/** The turn parked until people decide the tool approvals it asked for. */
	TurnSuspended: {
		readonly chatId: string;
		readonly workspaceId: string;
		readonly turnId: string;
	};
	/**
	 * A run of the turn failed, or the turn was found stopped and ended as
	 * failed. `willRetry` is whether its owner runs it again.
	 */
	TurnFailed: {
		readonly chatId: string;
		readonly workspaceId: string;
		readonly turnId: string;
		readonly botId: string;
		readonly messageId: string;
		/** What people are told went wrong. */
		readonly userMessage: UserText;
		readonly willRetry: boolean;
	};
	/** The turn was cancelled, or found stopped and ended as cancelled, keeping the reply written so far. */
	TurnCancelled: {
		readonly chatId: string;
		readonly workspaceId: string;
		readonly turnId: string;
		readonly botId: string;
		readonly messageId: string;
		readonly content: string;
	};
	/** Somebody asked a running turn to stop, or its automation run ended. */
	TurnCancelRequested: {
		readonly chatId: string;
		readonly turnId: string;
	};
	/**
	 * The bot `botId`'s turn in the chat was given up with no active
	 * turn left to end: it could not open, or its workflow failed while none
	 * was running. `outcome` is how it ended.
	 */
	TurnAbandoned: {
		readonly chatId: string;
		readonly botId: string;
		readonly outcome: Turns.Ended;
	};
	/**
	 * A turn's workflow in the chat finished and freed its
	 * lane, so it no longer keeps the chat busy.
	 */
	LaneReleased: { readonly chatId: string };
	/** A reply called a tool: the call is running, or waiting for a person to approve it. */
	ToolCallStarted: ToolCallChange;
	/** A person allowed or denied a call, which the lists hear of, since it no longer waits on anyone. */
	ToolCallDecided: ToolCallChange & { readonly workspaceId: string };
	/** An allowed call began running. */
	ToolCallExecuting: ToolCallChange;
	/** The call returned, failed, or was abandoned with its turn. */
	ToolCallFinished: ToolCallChange;
	/** A bot opened a chat for a collaborator, and briefed it there. */
	CollaborationOpened: CollaborationChange & {
		readonly workspaceId: string;
		readonly collaboratorBotId: string;
		/** The brief, the first message in the collaboration's chat. */
		readonly briefMessageId: string;
	};
	/** The asking turn stopped waiting; the answer will resume it instead. */
	CollaborationStoppedWaiting: CollaborationChange;
	/** The collaborator's reply was recorded as the answer. */
	CollaborationAnswered: CollaborationChange & AskerResume;
	/**
	 * The collaboration ended unanswered: the automation run it worked for ended,
	 * or the collaborator's turn ended without an answer.
	 */
	CollaborationFailed: CollaborationChange & AskerResume;
	/** `person` read further into the chat, at `readAt`: every message created up to `readThrough`. */
	ChatRead: {
		readonly chatId: string;
		readonly person: PersonParticipant;
		readonly readThrough: Date;
		readonly readAt: Date;
	};
	/** Somebody started the bot's chat `chatId`. */
	ChatStarted: {
		readonly workspaceId: string;
		readonly chatId: string;
	};
	/**
	 * A bot started the chat `chatId` for the person it was answering,
	 * with the bot `hostBotId`, whose first message is the brief it works from.
	 */
	BriefedChatStarted: {
		readonly workspaceId: string;
		readonly chatId: string;
		readonly hostBotId: string;
		readonly briefMessageId: string;
	};
	/** Somebody started or renamed the project's chat `chatId`. */
	ProjectChatChanged: {
		readonly workspaceId: string;
		readonly chatId: string;
	};
	/** Somebody marked the chat resolved, or reopened it. */
	ChatResolvedChanged: {
		readonly workspaceId: string;
		readonly chatId: string;
	};
	/** The compaction bot replaced the chat's older history with a summary for its bots. */
	ChatCompacted: {
		readonly workspaceId: string;
		readonly chatId: string;
	};
	/** An automation run began in its own chat, listed in `rootChatId`. */
	RunAccepted: {
		readonly workspaceId: string;
		readonly rootChatId: string;
		readonly chatId: string;
	};
	/**
	 * An automation run was told to end, and the work still going on in its
	 * chats was cancelled: waiting turns, pending approvals, collaborations.
	 */
	AutomationWorkCancelled: {
		readonly workspaceId: string;
		readonly chatIds: readonly string[];
	};
	/** An automation run finished, failed, or was cancelled. */
	RunSettled: {
		readonly workspaceId: string;
		readonly rootChatId: string;
		readonly chatId: string;
	};
}>;

export const ChatEvent = Data.taggedEnum<ChatEvent>();

/** A tool call in the reply `messageId`, as it stands after the change. */
export interface ToolCallChange {
	readonly chatId: string;
	readonly messageId: string;
	readonly toolCall: ToolCallPart;
}

/**
 * A collaboration made in the reply `parentMessageId`, as it stands after the
 * change. Its own chat is `collaboration.chatId`.
 */
export interface CollaborationChange {
	readonly parentChatId: string;
	readonly parentMessageId: string;
	readonly collaboration: CollaborationPart;
}

/** Whether a collaboration's end is owed to the bot that asked, in a turn of its own. */
interface AskerResume {
	/**
	 * The asking bot, when its turn stopped waiting and so nothing is reading
	 * how the collaboration ended. Null while the asking tool still waits, and
	 * when the automation run the collaboration worked for ended, which takes no
	 * more turns.
	 */
	readonly askerToResume: string | null;
}
