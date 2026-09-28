import type { Message, ToolCallPart } from "@sugabots/contracts";
import { Data } from "effect";
import type { UserMessage } from "../user-message.ts";
import type { ModelAccounting } from "./turns/model.ts";

/**
 * What happened in a conversation, as the facts that changed.
 *
 * The stores emit these through `DomainEvents` in the transaction that wrote
 * them; `ThreadFeed` decides what a watching client is told. An event carries
 * the ids involved and what changed, plus what the feed would otherwise have
 * to query back, such as a finished reply's content. A tool call is carried
 * whole, as the thread shows it, because clients replace the part rather
 * than patch it.
 */
export type ConversationEvent = Data.TaggedEnum<{
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
		readonly turnId: string;
	};
	/**
	 * A run of the turn failed, or the turn was found stopped and ended as
	 * failed. `willRetry` is whether its owner runs it again.
	 */
	TurnFailed: {
		readonly threadId: string;
		readonly workspaceId: string;
		readonly turnId: string;
		readonly messageId: string;
		/** What people are told went wrong. */
		readonly userMessage: UserMessage;
		readonly willRetry: boolean;
	};
	/** The turn was cancelled, or found stopped and ended as cancelled, keeping the reply written so far. */
	TurnCancelled: {
		readonly threadId: string;
		readonly workspaceId: string;
		readonly turnId: string;
		readonly messageId: string;
		readonly content: string;
	};
	/** Somebody asked a running turn to stop. */
	TurnCancelRequested: {
		readonly threadId: string;
		readonly turnId: string;
	};
	/** A reply called a tool: the call is running, or waiting for a person to approve it. */
	ToolCallStarted: ToolCallChange;
	/** A person allowed or denied a call. */
	ToolCallDecided: ToolCallChange;
	/** An allowed call began running. */
	ToolCallExecuting: ToolCallChange;
	/** The call returned, failed, or was abandoned with its turn. */
	ToolCallFinished: ToolCallChange;
}>;

export const ConversationEvent = Data.taggedEnum<ConversationEvent>();

/** A tool call in the reply `messageId`, as it stands after the change. */
export interface ToolCallChange {
	readonly threadId: string;
	readonly messageId: string;
	readonly toolCall: ToolCallPart;
}
