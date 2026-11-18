export * as ConversationFeed from "./conversation-feed.ts";

import { conversationChannel, streamEvent, workspaceChannel } from "@sugabots/contracts";
import type { UserText } from "@sugabots/errors";
import { Effect } from "effect";
import { Audience } from "../database/events/audience.ts";
import type { DomainEvents } from "../database/events/domain-events.ts";
import type { EventOutbox, PendingEvent } from "../database/events/outbox.ts";
import { type CollaborationChange, ConversationEvent, type ToolCallChange } from "./events.ts";

/** Publishes, on the emitting transaction, the stream events that show watching clients what happened. */
export const handler =
	(outbox: EventOutbox.Interface): DomainEvents.Handler<ConversationEvent> =>
	(events) => {
		const pending = events.flatMap(streamEventsFor);
		return pending.length === 0 ? Effect.void : outbox.publish(pending);
	};

/**
 * The one place stream events are built: which channels an event goes on,
 * and what each carries.
 *
 * A conversation's events go on its own channel. The workspace channel, which feeds
 * the lists, hears `conversation.changed` naming the conversation whenever what a list
 * shows of it may have changed, for the people who reach the conversation alone
 * (see `Audience`).
 */
function streamEventsFor(event: ConversationEvent): PendingEvent[] {
	return ConversationEvent.$match(event, {
		MessagePosted: ({ conversationId, workspaceId, message }) => [
			onConversation(conversationId, streamEvent("message.created", { conversationId, message })),
			listedConversationChanged(workspaceId, conversationId),
		],
		ReactionsChanged: ({ conversationId, messageId, reactions }) => [
			onConversation(
				conversationId,
				streamEvent("message.reactions_changed", {
					conversationId,
					messageId,
					reactions: [...reactions],
				}),
			),
		],
		MessageFilesChanged: ({ conversationId, messageId, files }) => [
			onConversation(
				conversationId,
				streamEvent("message.files_changed", { conversationId, messageId, files: [...files] }),
			),
		],
		BotsJoined: ({ conversationId }) => [
			onConversation(conversationId, streamEvent("conversation.changed", { conversationId })),
		],
		TurnStarted: ({ conversationId, turnId, botId, reply }) => [
			onConversation(
				conversationId,
				streamEvent("turn.started", { conversationId, turnId, botId }),
			),
			onConversation(
				conversationId,
				streamEvent("message.created", { conversationId, message: reply }),
			),
		],
		TurnCompleted: ({ conversationId, workspaceId, turnId, messageId, content }) => [
			onConversation(
				conversationId,
				streamEvent("message.completed", {
					conversationId,
					messageId,
					content,
					status: "complete",
				}),
			),
			onConversation(
				conversationId,
				streamEvent("turn.completed", { conversationId, turnId, status: "done" }),
			),
			listedConversationChanged(workspaceId, conversationId),
		],
		TurnSuspended: ({ conversationId, workspaceId }) => [
			listedConversationChanged(workspaceId, conversationId),
		],
		TurnFailed: ({ conversationId, workspaceId, turnId, messageId, userMessage, willRetry }) => [
			onConversation(
				conversationId,
				streamEvent("message.failed", {
					conversationId,
					messageId,
					turnId,
					willRetry,
					error: userMessage,
				}),
			),
			// The conversation stops working only once nobody runs the turn again.
			...(willRetry ? [] : [listedConversationChanged(workspaceId, conversationId)]),
		],
		TurnCancelled: ({ conversationId, workspaceId, turnId, messageId, content }) => [
			onConversation(
				conversationId,
				streamEvent("message.completed", {
					conversationId,
					messageId,
					content,
					status: "cancelled",
				}),
			),
			onConversation(
				conversationId,
				streamEvent("turn.completed", { conversationId, turnId, status: "cancelled" }),
			),
			listedConversationChanged(workspaceId, conversationId),
		],
		TurnQueued: ({ conversationId }) => [
			onConversation(conversationId, streamEvent("conversation.changed", { conversationId })),
		],
		TurnCancelRequested: ({ conversationId, turnId }) => [
			onConversation(
				conversationId,
				streamEvent("turn.cancel_requested", { conversationId, turnId }),
			),
		],
		// A turn that could not open leaves nothing waiting for it, so the conversation is
		// fetched again. Nobody is shown one given up as cancelled: it was not wanted
		// any more, and the automation run it was dropped with says what changed.
		TurnAbandoned: ({ conversationId, outcome }) =>
			outcome.state === "failed"
				? [
						onConversation(conversationId, streamEvent("conversation.changed", { conversationId })),
						notice(conversationId, outcome.error),
					]
				: [],
		// Watchers see nothing new in this; only automation settlement reacts to it.
		LaneReleased: () => [],
		ToolCallStarted: (change) => [toolCallEvent("tool_call.started", change)],
		ToolCallDecided: (change) => [
			toolCallEvent("tool_call.updated", change),
			listedConversationChanged(change.workspaceId, change.conversationId),
		],
		ToolCallExecuting: (change) => [toolCallEvent("tool_call.updated", change)],
		ToolCallFinished: (change) => [toolCallEvent("tool_call.completed", change)],
		CollaborationOpened: (opened) => [
			collaborationUpdated(opened),
			listedConversationChanged(opened.workspaceId, opened.collaboration.conversationId),
		],
		CollaborationStoppedWaiting: (change) => [collaborationUpdated(change)],
		CollaborationAnswered: (change) => [collaborationUpdated(change)],
		CollaborationFailed: (change) => [collaborationUpdated(change)],
		ConversationRead: ({ conversationId, person, readThrough, readAt }) => [
			onConversation(
				conversationId,
				streamEvent("conversation.read", {
					conversationId,
					person,
					readThrough: readThrough.toISOString(),
					readAt: readAt.toISOString(),
				}),
			),
		],
		TaskStarted: ({ workspaceId, conversationId }) => [
			listedConversationChanged(workspaceId, conversationId),
		],
		BriefedTaskStarted: ({ workspaceId, conversationId }) => [
			listedConversationChanged(workspaceId, conversationId),
		],
		ConversationDoneChanged: ({ workspaceId, conversationId }) =>
			conversationChanged(workspaceId, conversationId),
		ChannelConversationChanged: ({ workspaceId, conversationId }) =>
			conversationChanged(workspaceId, conversationId),
		ConversationSummarised: ({ workspaceId, conversationId }) =>
			conversationChanged(workspaceId, conversationId),
		ConversationCompacted: ({ workspaceId, conversationId }) =>
			conversationChanged(workspaceId, conversationId),
		RunAccepted: ({ workspaceId, rootConversationId, conversationId }) => [
			itemChanged(workspaceId, rootConversationId, conversationId),
		],
		AutomationWorkCancelled: ({ workspaceId, conversationIds }) =>
			conversationIds.flatMap((conversationId) => conversationChanged(workspaceId, conversationId)),
		RunSettled: ({ workspaceId, rootConversationId, conversationId }) => [
			itemChanged(workspaceId, rootConversationId, conversationId),
		],
	});
}

function onConversation(conversationId: string, event: PendingEvent["event"]): PendingEvent {
	return { channel: conversationChannel(conversationId), event };
}

/** Tells the conversation's watchers why a reply they may be waiting for is not coming. */
function notice(conversationId: string, userMessage: UserText): PendingEvent {
	return onConversation(
		conversationId,
		streamEvent("conversation.notice", { conversationId, notice: userMessage }),
	);
}

/** For a change no more specific event on the conversation's channel describes. */
function conversationChanged(workspaceId: string, conversationId: string): PendingEvent[] {
	return [
		onConversation(conversationId, streamEvent("conversation.changed", { conversationId })),
		listedConversationChanged(workspaceId, conversationId),
	];
}

/** Tells the lists showing the conversation, for those who reach it, that it changed. */
function listedConversationChanged(workspaceId: string, conversationId: string): PendingEvent {
	return {
		channel: workspaceChannel(workspaceId),
		event: Audience.forConversation(
			conversationId,
			streamEvent("conversation.changed", { conversationId }),
		),
	};
}

/**
 * Tells the watchers of `rootConversationId` that it now shows, or shows
 * differently, the conversation `conversationId` opened beside it.
 */
function itemChanged(
	workspaceId: string,
	rootConversationId: string,
	conversationId: string,
): PendingEvent {
	return {
		channel: workspaceChannel(workspaceId),
		event: Audience.forConversation(
			rootConversationId,
			streamEvent("conversation.item_changed", { rootConversationId, conversationId }),
		),
	};
}

/** Collaborations show in the reply that made them, in the parent conversation. */
function collaborationUpdated({
	parentConversationId,
	parentMessageId,
	collaboration,
}: CollaborationChange): PendingEvent {
	return onConversation(
		parentConversationId,
		streamEvent("collaboration.updated", {
			conversationId: parentConversationId,
			messageId: parentMessageId,
			collaboration,
		}),
	);
}

function toolCallEvent(
	type: "tool_call.started" | "tool_call.updated" | "tool_call.completed",
	{ conversationId, messageId, toolCall }: ToolCallChange,
): PendingEvent {
	return onConversation(conversationId, streamEvent(type, { conversationId, messageId, toolCall }));
}
