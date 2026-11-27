export * as ChatEventStream from "./chat-event-stream.ts";

import { chatStream, memberStream, streamEvent, workspaceStream } from "@sugabots/contracts";
import type { UserText } from "@sugabots/errors";
import { Effect } from "effect";
import { query } from "../database/database.ts";
import { Audience } from "../database/events/audience.ts";
import type { DomainEvents } from "../database/events/domain-events.ts";
import type { EventOutbox, PendingEvent } from "../database/events/outbox.ts";
import { approvalAudience } from "../proofs/approvers.ts";
import { ChatEvent, type ToolCallChange } from "./events.ts";

/** Publishes, on the emitting transaction, the stream events that show watching clients what happened. */
export const handler =
	(outbox: EventOutbox.Interface): DomainEvents.Handler<ChatEvent> =>
	(events) => {
		const pending = events.flatMap(streamEventsFor);
		return pending.length === 0 ? Effect.void : outbox.publish(pending);
	};

export const approvalHandler =
	(outbox: EventOutbox.Interface): DomainEvents.Handler<ChatEvent> =>
	(events) =>
		Effect.gen(function* () {
			const pending: PendingEvent[] = [];
			for (const event of events) {
				const approval =
					event._tag === "TurnSuspended"
						? event.approvalCallIds
						: event._tag === "ToolCallDecided" ||
								(event._tag === "ToolCallFinished" && event.toolCall.approval?.status === "denied")
							? [event.toolCall.id]
							: undefined;
				if (!approval) continue;
				for (const recipient of yield* query((db) => approvalAudience(db, approval))) {
					for (const call of recipient.calls) {
						pending.push({
							stream: memberStream(recipient.memberId),
							event: streamEvent("approvals.changed", { toolCallId: call.id }),
						});
					}
				}
			}
			if (pending.length > 0) yield* outbox.publish(pending);
		});

/**
 * The one place stream events are built: which streams an event goes on,
 * and what each carries.
 *
 * A chat's events go on its own stream. The workspace stream, which feeds
 * the lists, hears `chat.changed` naming the chat whenever what a list
 * shows of it may have changed, for the members who reach the chat alone
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
		TurnStarted: ({ chatId, workspaceId, reply }) => [
			onChat(chatId, streamEvent("turn.started", { chatId })),
			onChat(chatId, streamEvent("message.created", { chatId, message: reply })),
			// A list shows a bot working in the chat.
			listedChatChanged(workspaceId, chatId),
		],
		ReplyExecutionStarted: ({ chatId, messageId, execution, content, thinking }) => [
			onChat(
				chatId,
				streamEvent("message.execution_started", {
					chatId,
					messageId,
					execution,
					content,
					thinking,
				}),
			),
		],
		TurnCompleted: ({ chatId, workspaceId, messageId, execution, content, finishedAt }) => [
			onChat(
				chatId,
				streamEvent("message.completed", {
					chatId,
					messageId,
					execution,
					content,
					status: "complete",
					finishedAt: finishedAt.toISOString(),
				}),
			),
			onChat(chatId, streamEvent("turn.completed", { chatId })),
			listedChatChanged(workspaceId, chatId),
		],
		// Refresh the chat after the empty reply is removed.
		TurnStayedSilent: ({ chatId, workspaceId }) => [
			onChat(chatId, streamEvent("turn.completed", { chatId })),
			...chatChanged(workspaceId, chatId),
		],
		TurnSuspended: ({ chatId, workspaceId }) => [listedChatChanged(workspaceId, chatId)],
		TurnFailed: ({ chatId, workspaceId, messageId, execution, userMessage, willRetry }) => [
			onChat(
				chatId,
				streamEvent("message.failed", { chatId, messageId, execution, error: userMessage }),
			),
			// The chat stops working only once nobody runs the turn again.
			...(willRetry ? [] : [listedChatChanged(workspaceId, chatId)]),
		],
		TurnInterrupted: ({ chatId, workspaceId, messageId, execution, content, finishedAt }) => [
			onChat(
				chatId,
				streamEvent("message.completed", {
					chatId,
					messageId,
					execution,
					content,
					status: "cancelled",
					finishedAt: finishedAt.toISOString(),
				}),
			),
			onChat(chatId, streamEvent("turn.completed", { chatId })),
			listedChatChanged(workspaceId, chatId),
		],
		TurnQueued: ({ chatId }) => [onChat(chatId, streamEvent("chat.changed", { chatId }))],
		TurnInterruptRequested: ({ chatId, turnId }) => [
			onChat(chatId, streamEvent("turn.interrupt_requested", { chatId, turnId })),
		],
		// A turn that could not open leaves nothing waiting for it, so the chat is
		// fetched again. Nobody is shown one given up as cancelled: it was not wanted
		// any more, and the automation run it was dropped with says what changed.
		TurnAbandoned: ({ chatId, outcome }) =>
			outcome.state === "failed"
				? [onChat(chatId, streamEvent("chat.changed", { chatId })), notice(chatId, outcome.error)]
				: [],
		// Watchers see nothing new in this; only automation settlement and the floor react to it.
		LaneReleased: () => [],
		ToolCallStarted: (change) => [toolCallEvent("tool_call.started", change)],
		ToolCallDecided: (change) => [
			toolCallEvent("tool_call.updated", change),
			listedChatChanged(change.workspaceId, change.chatId),
		],
		ToolCallExecuting: (change) => [toolCallEvent("tool_call.updated", change)],
		ToolCallFinished: (change) => [toolCallEvent("tool_call.completed", change)],
		ChatRead: ({ chatId, member, readThrough, readAt }) => [
			onChat(
				chatId,
				streamEvent("chat.read", {
					chatId,
					member,
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
			nestedChatChanged(workspaceId, rootChatId, chatId),
		],
		AutomationWorkCancelled: ({ workspaceId, chatId }) => chatChanged(workspaceId, chatId),
		RunSettled: ({ workspaceId, rootChatId, chatId }) => [
			nestedChatChanged(workspaceId, rootChatId, chatId),
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
 * differently, the chat `chatId` nested under it.
 */
function nestedChatChanged(workspaceId: string, rootChatId: string, chatId: string): PendingEvent {
	return {
		stream: workspaceStream(workspaceId),
		event: Audience.forChat(
			rootChatId,
			streamEvent("chat.nested_chat_changed", { rootChatId, chatId }),
		),
	};
}

function toolCallEvent(
	type: "tool_call.started" | "tool_call.updated" | "tool_call.completed",
	{ chatId, messageId, toolCall }: ToolCallChange,
): PendingEvent {
	return onChat(chatId, streamEvent(type, { chatId, messageId, toolCall }));
}
