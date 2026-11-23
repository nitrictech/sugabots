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
 * What happened in a conversation, as the facts that changed.
 *
 * The repositories emit these through `DomainEvents` in the transaction that wrote
 * them; `ConversationFeed` decides what a watching client is told. An event carries
 * the ids involved and what changed, plus what the feed would otherwise have
 * to query back, such as a finished reply's content. A tool call or
 * collaboration is carried whole, as the conversation shows it, because clients
 * replace the part rather than patch it. An event the workspace's lists hear
 * of carries its conversation, so only people who reach the conversation are told.
 */
export type ConversationEvent = Data.TaggedEnum<{
	/** A message was posted whole: a person's, or an automation run's result. */
	MessagePosted: {
		readonly conversationId: string;
		readonly workspaceId: string;
		readonly message: Message;
	};
	/** Somebody reacted to a message or took a reaction back. `reactions` is all it has now. */
	ReactionsChanged: {
		readonly conversationId: string;
		readonly messageId: string;
		readonly reactions: readonly MessageReaction[];
	};
	/**
	 * A bot attached a file to its reply. `files` is all the reply carries
	 * now; a reply that starts again starts without them, as its `TurnStarted` says.
	 */
	MessageFilesChanged: {
		readonly conversationId: string;
		readonly messageId: string;
		readonly files: readonly FilePart[];
	};
	/** Bots were brought into the conversation to answer in it. */
	BotsJoined: { readonly conversationId: string; readonly botIds: readonly string[] };
	/**
	 * A bot's turn was asked for while it was already answering in the
	 * conversation, so it waits to start, and will read what was posted meanwhile.
	 */
	TurnQueued: { readonly conversationId: string };
	/** A bot's turn opened, with its reply as an empty `streaming` message. Not emitted when a suspended turn resumes. */
	TurnStarted: {
		readonly conversationId: string;
		readonly workspaceId: string;
		readonly turnId: string;
		readonly botId: string;
		readonly reply: Message;
	};
	/** The turn finished and its reply is complete. */
	TurnCompleted: {
		readonly conversationId: string;
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
		readonly conversationId: string;
		readonly workspaceId: string;
		readonly turnId: string;
		readonly botId: string;
	};
	/** The turn parked until people decide the tool approvals it asked for. */
	TurnSuspended: {
		readonly conversationId: string;
		readonly workspaceId: string;
		readonly turnId: string;
	};
	/**
	 * A run of the turn failed, or the turn was found stopped and ended as
	 * failed. `willRetry` is whether its owner runs it again.
	 */
	TurnFailed: {
		readonly conversationId: string;
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
		readonly conversationId: string;
		readonly workspaceId: string;
		readonly turnId: string;
		readonly botId: string;
		readonly messageId: string;
		readonly content: string;
	};
	/** Somebody asked a running turn to stop, or its automation run ended. */
	TurnCancelRequested: {
		readonly conversationId: string;
		readonly turnId: string;
	};
	/**
	 * The bot `botId`'s turn in the conversation was given up with no active
	 * turn left to end: it could not open, or its workflow failed while none
	 * was running. `outcome` is how it ended.
	 */
	TurnAbandoned: {
		readonly conversationId: string;
		readonly botId: string;
		readonly outcome: Turns.Ended;
	};
	/**
	 * A turn's workflow in the conversation finished and freed its
	 * lane, so it no longer keeps the conversation busy.
	 */
	LaneReleased: { readonly conversationId: string };
	/** A reply called a tool: the call is running, or waiting for a person to approve it. */
	ToolCallStarted: ToolCallChange;
	/** A person allowed or denied a call, which the lists hear of, since it no longer waits on anyone. */
	ToolCallDecided: ToolCallChange & { readonly workspaceId: string };
	/** An allowed call began running. */
	ToolCallExecuting: ToolCallChange;
	/** The call returned, failed, or was abandoned with its turn. */
	ToolCallFinished: ToolCallChange;
	/** A bot opened a conversation for a collaborator, and briefed it there. */
	CollaborationOpened: CollaborationChange & {
		readonly workspaceId: string;
		readonly collaboratorBotId: string;
		/** The brief, the first message in the collaboration's conversation. */
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
	/** `person` read further into the conversation, at `readAt`: every message created up to `readThrough`. */
	ConversationRead: {
		readonly conversationId: string;
		readonly person: PersonParticipant;
		readonly readThrough: Date;
		readonly readAt: Date;
	};
	/** Somebody started the bot's thread `conversationId`. */
	ThreadStarted: {
		readonly workspaceId: string;
		readonly conversationId: string;
	};
	/**
	 * A bot started the conversation `conversationId` for the person it was answering,
	 * with the bot `hostBotId`, whose first message is the brief it works from.
	 */
	BriefedThreadStarted: {
		readonly workspaceId: string;
		readonly conversationId: string;
		readonly hostBotId: string;
		readonly briefMessageId: string;
	};
	/** Somebody started, renamed or archived the project's thread `conversationId`. */
	ProjectThreadChanged: {
		readonly workspaceId: string;
		readonly conversationId: string;
	};
	/** Somebody marked the conversation done, or reopened it. */
	ConversationDoneChanged: {
		readonly workspaceId: string;
		readonly conversationId: string;
	};
	/** The compaction bot replaced the conversation's older history with a summary for its bots. */
	ConversationCompacted: {
		readonly workspaceId: string;
		readonly conversationId: string;
	};
	/** An automation run began in its own conversation, listed in `rootConversationId`. */
	RunAccepted: {
		readonly workspaceId: string;
		readonly rootConversationId: string;
		readonly conversationId: string;
	};
	/**
	 * An automation run was told to end, and the work still going on in its
	 * conversations was cancelled: waiting turns, pending approvals, collaborations.
	 */
	AutomationWorkCancelled: {
		readonly workspaceId: string;
		readonly conversationIds: readonly string[];
	};
	/** An automation run finished, failed, or was cancelled. */
	RunSettled: {
		readonly workspaceId: string;
		readonly rootConversationId: string;
		readonly conversationId: string;
	};
}>;

export const ConversationEvent = Data.taggedEnum<ConversationEvent>();

/** A tool call in the reply `messageId`, as it stands after the change. */
export interface ToolCallChange {
	readonly conversationId: string;
	readonly messageId: string;
	readonly toolCall: ToolCallPart;
}

/**
 * A collaboration made in the reply `parentMessageId`, as it stands after the
 * change. Its own conversation is `collaboration.conversationId`.
 */
export interface CollaborationChange {
	readonly parentConversationId: string;
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
