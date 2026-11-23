export * as ChatEventStream from "./chat-event-stream.ts";

import { chatStream, streamEvent, workspaceStream } from "@sugabots/contracts";
import type { UserText } from "@sugabots/errors";
import { Effect } from "effect";
import { Audience } from "../database/events/audience.ts";
import type { DomainEvents } from "../database/events/domain-events.ts";
import type { EventOutbox, PendingEvent } from "../database/events/outbox.ts";
import { ChatEvent, type CollaborationChange, type ToolCallChange } from "./events.ts";

/** Publishes, on the emitting transaction, the stream events that show watching clients what happened. */
export const handler =
	(outbox: EventOutbox.Interface): DomainEvents.Handler<ChatEvent> =>
	(events) => {
		const pending = events.flatMap(streamEventsFor);
		return pending.length === 0 ? Effect.void : outbox.publish(pending);
	};

/**
 * The one place stream events are built: which streams an event goes on,
 * and what each carries.
 *
 * A chat's events go on its own stream. The workspace stream, which feeds
 * the lists, hears `chat.changed` naming the chat whenever what a list
 * shows of it may have changed, for the people who reach the chat alone
 * (see `Audience`).
 */
function streamEventsFor(event: ChatEvent): PendingEvent[] {
	return ChatEvent.$match(event, {
		MessagePosted: ({ chatId, workspaceId, message }) => [
			onChat(chatId, streamEvent("message.created", { chatId, message })),
			listedChatChanged(workspaceId, chatId),
		],
		ReactionsChanged: ({ chatId, messageId, reactions }) => [
			onChat(
				chatId,
				streamEvent("message.reactions_changed", {
					chatId,
					messageId,
					reactions: [...reactions],
				}),
			),
		],
		MessageFilesChanged: ({ chatId, messageId, files }) => [
			onChat(
				chatId,
				streamEvent("message.files_changed", { chatId, messageId, files: [...files] }),
			),
		],
		BotsJoined: ({ chatId }) => [onChat(chatId, streamEvent("chat.changed", { chatId }))],
		TurnStarted: ({ chatId, workspaceId, turnId, botId, reply }) => [
			onChat(chatId, streamEvent("turn.started", { chatId, turnId, botId })),
			onChat(chatId, streamEvent("message.created", { chatId, message: reply })),
			// A list shows a bot working in the chat.
			listedChatChanged(workspaceId, chatId),
		],
		TurnCompleted: ({ chatId, workspaceId, turnId, messageId, content }) => [
			onChat(
				chatId,
				streamEvent("message.completed", {
					chatId,
					messageId,
					content,
					status: "complete",
				}),
			),
			onChat(chatId, streamEvent("turn.completed", { chatId, turnId, status: "done" })),
			listedChatChanged(workspaceId, chatId),
		],
		// Its empty reply is gone, so the chat is fetched again without it.
		TurnStayedSilent: ({ chatId, workspaceId, turnId }) => [
			onChat(chatId, streamEvent("turn.completed", { chatId, turnId, status: "done" })),
			...chatChanged(workspaceId, chatId),
		],
		TurnSuspended: ({ chatId, workspaceId }) => [listedChatChanged(workspaceId, chatId)],
		TurnFailed: ({ chatId, workspaceId, turnId, messageId, userMessage, willRetry }) => [
			onChat(
				chatId,
				streamEvent("message.failed", {
					chatId,
					messageId,
					turnId,
					error: userMessage,
				}),
			),
			// The chat stops working only once nobody runs the turn again.
			...(willRetry ? [] : [listedChatChanged(workspaceId, chatId)]),
		],
		TurnCancelled: ({ chatId, workspaceId, turnId, messageId, content }) => [
			onChat(
				chatId,
				streamEvent("message.completed", {
					chatId,
					messageId,
					content,
					status: "cancelled",
				}),
			),
			onChat(chatId, streamEvent("turn.completed", { chatId, turnId, status: "cancelled" })),
			listedChatChanged(workspaceId, chatId),
		],
		TurnQueued: ({ chatId }) => [onChat(chatId, streamEvent("chat.changed", { chatId }))],
		TurnCancelRequested: ({ chatId, turnId }) => [
			onChat(chatId, streamEvent("turn.cancel_requested", { chatId, turnId })),
		],
		// A turn that could not open leaves nothing waiting for it, so the chat is
		// fetched again. Nobody is shown one given up as cancelled: it was not wanted
		// any more, and the automation run it was dropped with says what changed.
		TurnAbandoned: ({ chatId, outcome }) =>
			outcome.state === "failed"
				? [onChat(chatId, streamEvent("chat.changed", { chatId })), notice(chatId, outcome.error)]
				: [],
		// Watchers see nothing new in this; only automation settlement reacts to it.
		LaneReleased: () => [],
		ToolCallStarted: (change) => [toolCallEvent("tool_call.started", change)],
		ToolCallDecided: (change) => [
			toolCallEvent("tool_call.updated", change),
			listedChatChanged(change.workspaceId, change.chatId),
		],
		ToolCallExecuting: (change) => [toolCallEvent("tool_call.updated", change)],
		ToolCallFinished: (change) => [toolCallEvent("tool_call.completed", change)],
		CollaborationOpened: (opened) => [
			collaborationUpdated(opened),
			listedChatChanged(opened.workspaceId, opened.collaboration.chatId),
		],
		CollaborationStoppedWaiting: (change) => [collaborationUpdated(change)],
		CollaborationAnswered: (change) => [collaborationUpdated(change)],
		CollaborationFailed: (change) => [collaborationUpdated(change)],
		ChatRead: ({ chatId, person, readThrough, readAt }) => [
			onChat(
				chatId,
				streamEvent("chat.read", {
					chatId,
					person,
					readThrough: readThrough.toISOString(),
					readAt: readAt.toISOString(),
				}),
			),
		],
		ChatStarted: ({ workspaceId, chatId }) => [listedChatChanged(workspaceId, chatId)],
		BriefedChatStarted: ({ workspaceId, chatId }) => [listedChatChanged(workspaceId, chatId)],
		ChatResolvedChanged: ({ workspaceId, chatId }) => chatChanged(workspaceId, chatId),
		ProjectChatChanged: ({ workspaceId, chatId }) => chatChanged(workspaceId, chatId),
		ChatCompacted: ({ workspaceId, chatId }) => chatChanged(workspaceId, chatId),
		RunAccepted: ({ workspaceId, rootChatId, chatId }) => [
			itemChanged(workspaceId, rootChatId, chatId),
		],
		AutomationWorkCancelled: ({ workspaceId, chatIds }) =>
			chatIds.flatMap((chatId) => chatChanged(workspaceId, chatId)),
		RunSettled: ({ workspaceId, rootChatId, chatId }) => [
			itemChanged(workspaceId, rootChatId, chatId),
		],
	});
}

function onChat(chatId: string, event: PendingEvent["event"]): PendingEvent {
	return { stream: chatStream(chatId), event };
}

/** Tells the chat's watchers why a reply they may be waiting for is not coming. */
function notice(chatId: string, userMessage: UserText): PendingEvent {
	return onChat(chatId, streamEvent("chat.notice", { chatId, notice: userMessage }));
}

/** For a change no more specific event on the chat's stream describes. */
function chatChanged(workspaceId: string, chatId: string): PendingEvent[] {
	return [
		onChat(chatId, streamEvent("chat.changed", { chatId })),
		listedChatChanged(workspaceId, chatId),
	];
}

/** Tells the lists showing the chat, for those who reach it, that it changed. */
function listedChatChanged(workspaceId: string, chatId: string): PendingEvent {
	return {
		stream: workspaceStream(workspaceId),
		event: Audience.forChat(chatId, streamEvent("chat.changed", { chatId })),
	};
}

/**
 * Tells the watchers of `rootChatId` that it now shows, or shows
 * differently, the chat `chatId` opened beside it.
 */
function itemChanged(workspaceId: string, rootChatId: string, chatId: string): PendingEvent {
	return {
		stream: workspaceStream(workspaceId),
		event: Audience.forChat(rootChatId, streamEvent("chat.item_changed", { rootChatId, chatId })),
	};
}

/** Collaborations show in the reply that made them, in the parent chat. */
function collaborationUpdated({
	parentChatId,
	parentMessageId,
	collaboration,
}: CollaborationChange): PendingEvent {
	return onChat(
		parentChatId,
		streamEvent("collaboration.updated", {
			chatId: parentChatId,
			messageId: parentMessageId,
			collaboration,
		}),
	);
}

function toolCallEvent(
	type: "tool_call.started" | "tool_call.updated" | "tool_call.completed",
	{ chatId, messageId, toolCall }: ToolCallChange,
): PendingEvent {
	return onChat(chatId, streamEvent(type, { chatId, messageId, toolCall }));
}
