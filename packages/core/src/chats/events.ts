import type {
	FilePart,
	MemberParticipant,
	Message,
	MessageReaction,
	ToolCallPart,
} from "@sugabots/contracts";
import type { UserText } from "@sugabots/errors";
import { Data } from "effect";
import type { TurnReason } from "./sql.ts";
import type { Turns } from "./turns/turns.ts";

/**
 * What happened in a chat, as the facts that changed.
 *
 * The stores emit these through `DomainEvents` in the transaction that wrote
 * them; `ChatEventStream` decides what a watching client is told. An event carries
 * the ids involved and what changed, plus what the chat event stream would otherwise have
 * to query back, such as a finished reply's content. A tool call is carried
 * whole, as the chat shows it, because clients replace the part rather than
 * patch it. An event the workspace's lists hear
 * of carries its chat, so only members who reach the chat are told.
 */
export type ChatEvent = Data.TaggedEnum<{
	/** A message was posted whole: a member's, or an automation run's result. */
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
		readonly finishedAt: Date;
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
	};
	/** The turn parked until members decide the tool approvals it asked for. */
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
		/** What members are told went wrong. */
		readonly userMessage: UserText;
		readonly willRetry: boolean;
	};
	/** The turn was cancelled, or found stopped and ended as cancelled, keeping the reply written so far. */
	TurnInterrupted: {
		readonly chatId: string;
		readonly workspaceId: string;
		readonly turnId: string;
		readonly botId: string;
		readonly messageId: string;
		readonly content: string;
		readonly finishedAt: Date;
	};
	/** A running turn was asked to stop, because its automation run ended. */
	TurnInterruptRequested: {
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
	 * The workflow of the bot `botId`'s turn on `triggerMessageId` in the chat
	 * finished and freed its lane, so it no longer keeps the chat busy.
	 */
	LaneReleased: {
		readonly chatId: string;
		readonly botId: string;
		readonly triggerMessageId: string;
		readonly reason: TurnReason;
	};
	/** A reply called a tool: the call is running, or waiting for a member to approve it. */
	ToolCallStarted: ToolCallChange;
	/** A member allowed or denied a call, which the lists hear of, since it no longer waits on anyone. */
	ToolCallDecided: ToolCallChange & { readonly workspaceId: string };
	/** An allowed call began running. */
	ToolCallExecuting: ToolCallChange;
	/** The call returned, failed, or was abandoned with its turn. */
	ToolCallFinished: ToolCallChange;
	/** `member` read further into the chat, at `readAt`: every message created up to `readThrough`. */
	ChatRead: {
		readonly chatId: string;
		readonly member: MemberParticipant;
		readonly readThrough: Date;
		readonly readAt: Date;
	};
	/** Somebody started the bot's chat `chatId`. */
	ChatStarted: {
		readonly workspaceId: string;
		readonly chatId: string;
	};
	/**
	 * A bot started the chat `chatId` for the member it was answering,
	 * with the bot `briefedBotId`, whose first message is the brief it works from.
	 */
	BriefedChatStarted: {
		readonly workspaceId: string;
		readonly chatId: string;
		readonly briefedBotId: string;
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
	/** The Compaction bot compacted the chat's history for its bots. */
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
	 * chat `chatId` was cancelled: waiting turns and pending approvals.
	 */
	AutomationWorkCancelled: {
		readonly workspaceId: string;
		readonly chatId: string;
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
