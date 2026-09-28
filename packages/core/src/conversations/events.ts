import type { CollaborationPart, Message, ToolCallPart } from "@sugabots/contracts";
import { Data } from "effect";
import type { UserMessage } from "../user-message.ts";
import type { Ended } from "./turns/lifecycle.ts";
import type { ModelAccounting } from "./turns/model.ts";

/**
 * What happened in a conversation, as the facts that changed.
 *
 * The repositories emit these through `DomainEvents` in the transaction that wrote
 * them; `ThreadFeed` decides what a watching client is told. An event carries
 * the ids involved and what changed, plus what the feed would otherwise have
 * to query back, such as a finished reply's content. A tool call or
 * collaboration is carried whole, as the thread shows it, because clients
 * replace the part rather than patch it. An event the workspace's lists hear
 * of carries its thread's pod, so only people who reach the pod are told.
 */
export type ConversationEvent = Data.TaggedEnum<{
	/** A person posted a message. */
	MessagePosted: { readonly threadId: string; readonly message: Message };
	/** Agents were brought into the thread to answer in it. */
	AgentsJoined: { readonly threadId: string; readonly agentIds: readonly string[] };
	/** An agent's turn opened, with its reply as an empty `streaming` message. Not emitted when a suspended turn resumes. */
	TurnStarted: {
		readonly threadId: string;
		readonly turnId: string;
		readonly agentId: string;
		readonly reply: Message;
	};
	/** The turn finished and its reply is complete. */
	TurnCompleted: {
		readonly threadId: string;
		readonly workspaceId: string;
		readonly podId: string;
		readonly turnId: string;
		readonly messageId: string;
		readonly content: string;
		readonly usage: ModelAccounting["usage"];
		readonly reportedCost: number | undefined;
	};
	/** The turn parked until people decide the tool approvals it asked for. */
	TurnSuspended: {
		readonly threadId: string;
		readonly workspaceId: string;
		readonly podId: string;
		readonly turnId: string;
	};
	/**
	 * A run of the turn failed, or the turn was found stopped and ended as
	 * failed. `willRetry` is whether its owner runs it again.
	 */
	TurnFailed: {
		readonly threadId: string;
		readonly workspaceId: string;
		readonly podId: string;
		readonly turnId: string;
		readonly agentId: string;
		readonly messageId: string;
		/** What people are told went wrong. */
		readonly userMessage: UserMessage;
		readonly willRetry: boolean;
	};
	/** The turn was cancelled, or found stopped and ended as cancelled, keeping the reply written so far. */
	TurnCancelled: {
		readonly threadId: string;
		readonly workspaceId: string;
		readonly podId: string;
		readonly turnId: string;
		readonly agentId: string;
		readonly messageId: string;
		readonly content: string;
	};
	/** Somebody asked a running turn to stop, or its routine run ended. */
	TurnCancelRequested: {
		readonly threadId: string;
		readonly turnId: string;
	};
	/**
	 * The agent `agentId`'s turn in the thread was given up with no active
	 * turn left to end: it could not open, or its workflow failed while none
	 * was running. `outcome` is how it ended.
	 */
	TurnAbandoned: { readonly threadId: string; readonly agentId: string; readonly outcome: Ended };
	/**
	 * A turn's or facilitation's workflow in the thread finished and freed its
	 * lane, so it no longer keeps the thread busy.
	 */
	LaneReleased: { readonly threadId: string };
	/**
	 * Every attempt at choosing who speaks after a message in the thread
	 * failed. `userMessage` says so in words fit for people.
	 */
	FacilitationFailed: { readonly threadId: string; readonly userMessage: UserMessage };
	/** A reply called a tool: the call is running, or waiting for a person to approve it. */
	ToolCallStarted: ToolCallChange;
	/** A person allowed or denied a call. */
	ToolCallDecided: ToolCallChange;
	/** An allowed call began running. */
	ToolCallExecuting: ToolCallChange;
	/** The call returned, failed, or was abandoned with its turn. */
	ToolCallFinished: ToolCallChange;
	/**
	 * An agent opened a child thread to brief a collaborator. `recipientChatId`
	 * is the collaborator's chat in the pod, whose history now lists the thread.
	 */
	CollaborationOpened: CollaborationChange & {
		readonly workspaceId: string;
		readonly podId: string;
		readonly recipientChatId: string | null;
	};
	/** The asking turn stopped waiting; the answer will resume it instead. */
	CollaborationStoppedWaiting: CollaborationChange;
	/** The collaborator's reply was recorded as the answer. */
	CollaborationAnswered: CollaborationChange;
	/**
	 * The collaboration ended unanswered: the routine run it worked for ended,
	 * or the collaborator's turn ended without an answer.
	 */
	CollaborationFailed: CollaborationChange;
	/** The Scribe rewrote the thread's summary, and on its first pass titled it. */
	ThreadSummarised: {
		readonly workspaceId: string;
		readonly podId: string;
		readonly threadId: string;
	};
	/** The compaction agent replaced the thread's older history with a summary for its bots. */
	ThreadCompacted: {
		readonly workspaceId: string;
		readonly podId: string;
		readonly threadId: string;
	};
	/** A routine run began in its own thread, listed in the agent's chat. */
	RoutineExecutionAccepted: {
		readonly workspaceId: string;
		readonly podId: string;
		readonly chatId: string;
		readonly threadId: string;
	};
	/**
	 * A routine run was told to end, and the work still going on in its
	 * threads was cancelled: waiting turns, pending approvals, collaborations.
	 */
	RoutineWorkCancelled: {
		readonly workspaceId: string;
		readonly podId: string;
		readonly threadIds: readonly string[];
	};
	/** A routine run finished, failed, or was cancelled. */
	RoutineExecutionSettled: {
		readonly workspaceId: string;
		readonly podId: string;
		readonly chatId: string;
		readonly threadId: string;
	};
}>;

export const ConversationEvent = Data.taggedEnum<ConversationEvent>();

/** A tool call in the reply `messageId`, as it stands after the change. */
export interface ToolCallChange {
	readonly threadId: string;
	readonly messageId: string;
	readonly toolCall: ToolCallPart;
}

/**
 * A collaboration made in the reply `parentMessageId`, as it stands after the
 * change. Its own thread is `collaboration.threadId`.
 */
export interface CollaborationChange {
	readonly parentThreadId: string;
	readonly parentMessageId: string;
	readonly collaboration: CollaborationPart;
}
