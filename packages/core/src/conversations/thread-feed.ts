export * as ThreadFeed from "./thread-feed.ts";

import { streamEvent, threadChannel, workspaceChannel } from "@sugabots/contracts";
import { Effect } from "effect";
import type { DomainEvents } from "../database/events/domain-events.ts";
import type { PendingEvent, PublishEvents } from "../database/events/publish.ts";
import { type CollaborationChange, ConversationEvent, type ToolCallChange } from "./events.ts";

/** Publishes, on the emitting transaction, the stream events that show watching clients what happened. */
export const handler =
	(publishEvents: PublishEvents): DomainEvents.Handler<ConversationEvent> =>
	(events) => {
		const pending = events.flatMap(streamEventsFor);
		return pending.length === 0 ? Effect.void : publishEvents(pending);
	};

/**
 * The one place stream events are built: which channels an event goes on,
 * and what each carries.
 *
 * A thread's events go on its own channel. The workspace channel, which feeds
 * the lists, hears `thread.changed` naming the thread whenever what a list
 * shows of it may have changed.
 */
function streamEventsFor(event: ConversationEvent): PendingEvent[] {
	return ConversationEvent.$match(event, {
		MessagePosted: ({ threadId, message }) => [
			onThread(threadId, streamEvent("message.created", { threadId, message })),
		],
		AgentsJoined: ({ threadId }) => [
			onThread(threadId, streamEvent("thread.changed", { threadId })),
		],
		TurnStarted: ({ threadId, turnId, agentId, reply }) => [
			onThread(threadId, streamEvent("turn.started", { threadId, turnId, agentId })),
			onThread(threadId, streamEvent("message.created", { threadId, message: reply })),
		],
		TurnCompleted: ({ threadId, workspaceId, turnId, messageId, content, usage, reportedCost }) => [
			onThread(
				threadId,
				streamEvent("message.completed", { threadId, messageId, content, status: "complete" }),
			),
			onThread(
				threadId,
				streamEvent("turn.completed", { threadId, turnId, status: "done", usage, reportedCost }),
			),
			listedThreadChanged(workspaceId, threadId),
		],
		TurnSuspended: ({ threadId, workspaceId }) => [listedThreadChanged(workspaceId, threadId)],
		TurnFailed: ({ threadId, workspaceId, turnId, messageId, userMessage, willRetry }) => [
			onThread(
				threadId,
				streamEvent("message.failed", {
					threadId,
					messageId,
					turnId,
					willRetry,
					error: userMessage,
				}),
			),
			// The thread stops working only once nobody runs the turn again.
			...(willRetry ? [] : [listedThreadChanged(workspaceId, threadId)]),
		],
		TurnCancelled: ({ threadId, workspaceId, turnId, messageId, content }) => [
			onThread(
				threadId,
				streamEvent("message.completed", { threadId, messageId, content, status: "cancelled" }),
			),
			onThread(threadId, streamEvent("turn.completed", { threadId, turnId, status: "cancelled" })),
			listedThreadChanged(workspaceId, threadId),
		],
		TurnCancelRequested: ({ threadId, turnId }) => [
			onThread(threadId, streamEvent("turn.cancel_requested", { threadId, turnId })),
		],
		ToolCallStarted: (change) => [toolCallEvent("tool_call.started", change)],
		ToolCallDecided: (change) => [toolCallEvent("tool_call.updated", change)],
		ToolCallExecuting: (change) => [toolCallEvent("tool_call.updated", change)],
		ToolCallFinished: (change) => [toolCallEvent("tool_call.completed", change)],
		CollaborationOpened: (opened) => [
			collaborationUpdated(opened),
			listedThreadChanged(opened.workspaceId, opened.collaboration.threadId),
			...(opened.recipientChatId
				? [
						{
							channel: workspaceChannel(opened.workspaceId),
							event: streamEvent("chat.thread_changed", {
								chatId: opened.recipientChatId,
								threadId: opened.collaboration.threadId,
								threadType: "collaboration",
							}),
						},
					]
				: []),
		],
		CollaborationStoppedWaiting: (change) => [collaborationUpdated(change)],
		CollaborationAnswered: (change) => [collaborationUpdated(change)],
		ThreadSummarised: ({ workspaceId, threadId }) => threadChanged(workspaceId, threadId),
		RoutineExecutionAccepted: ({ workspaceId, chatId, threadId }) => [
			routineThreadChanged(workspaceId, chatId, threadId),
		],
		RoutineWorkCancelled: ({ workspaceId, threadIds }) =>
			threadIds.flatMap((threadId) => threadChanged(workspaceId, threadId)),
		RoutineExecutionSettled: ({ workspaceId, chatId, threadId }) => [
			routineThreadChanged(workspaceId, chatId, threadId),
		],
	});
}

function onThread(threadId: string, event: PendingEvent["event"]): PendingEvent {
	return { channel: threadChannel(threadId), event };
}

/** For a change no more specific event on the thread's channel describes. */
function threadChanged(workspaceId: string, threadId: string): PendingEvent[] {
	return [
		onThread(threadId, streamEvent("thread.changed", { threadId })),
		listedThreadChanged(workspaceId, threadId),
	];
}

function listedThreadChanged(workspaceId: string, threadId: string): PendingEvent {
	return {
		channel: workspaceChannel(workspaceId),
		event: streamEvent("thread.changed", { threadId }),
	};
}

function routineThreadChanged(workspaceId: string, chatId: string, threadId: string): PendingEvent {
	return {
		channel: workspaceChannel(workspaceId),
		event: streamEvent("chat.thread_changed", { chatId, threadId, threadType: "routine" }),
	};
}

/** Collaborations show in the reply that made them, in the parent thread. */
function collaborationUpdated({
	parentThreadId,
	parentMessageId,
	collaboration,
}: CollaborationChange): PendingEvent {
	return onThread(
		parentThreadId,
		streamEvent("collaboration.updated", {
			threadId: parentThreadId,
			messageId: parentMessageId,
			collaboration,
		}),
	);
}

function toolCallEvent(
	type: "tool_call.started" | "tool_call.updated" | "tool_call.completed",
	{ threadId, messageId, toolCall }: ToolCallChange,
): PendingEvent {
	return onThread(threadId, streamEvent(type, { threadId, messageId, toolCall }));
}
