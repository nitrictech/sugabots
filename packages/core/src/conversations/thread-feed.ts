export * as ThreadFeed from "./thread-feed.ts";

import { streamEvent, threadChannel, workspaceChannel } from "@sugabots/contracts";
import { Effect } from "effect";
import type { DomainEvents } from "../database/events/domain-events.ts";
import type { EventOutbox, PendingEvent } from "../database/events/outbox.ts";
import { PodAudience } from "../database/events/pod-audience.ts";
import type { UserMessage } from "../user-message.ts";
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
 * A thread's events go on its own channel. The workspace channel, which feeds
 * the lists, hears `thread.changed` naming the thread whenever what a list
 * shows of it may have changed, for the people who reach the thread's pod
 * alone (see `PodAudience`).
 */
function streamEventsFor(event: ConversationEvent): PendingEvent[] {
	return ConversationEvent.$match(event, {
		MessagePosted: ({ threadId, workspaceId, podId, message }) => [
			onThread(threadId, streamEvent("message.created", { threadId, message })),
			listedThreadChanged(workspaceId, podId, threadId),
		],
		AgentsJoined: ({ threadId }) => [
			onThread(threadId, streamEvent("thread.changed", { threadId })),
		],
		TurnStarted: ({ threadId, turnId, agentId, reply }) => [
			onThread(threadId, streamEvent("turn.started", { threadId, turnId, agentId })),
			onThread(threadId, streamEvent("message.created", { threadId, message: reply })),
		],
		TurnCompleted: ({ threadId, workspaceId, podId, turnId, messageId, content }) => [
			onThread(
				threadId,
				streamEvent("message.completed", { threadId, messageId, content, status: "complete" }),
			),
			onThread(threadId, streamEvent("turn.completed", { threadId, turnId, status: "done" })),
			listedThreadChanged(workspaceId, podId, threadId),
		],
		TurnSuspended: ({ threadId, workspaceId, podId }) => [
			listedThreadChanged(workspaceId, podId, threadId),
		],
		TurnFailed: ({ threadId, workspaceId, podId, turnId, messageId, userMessage, willRetry }) => [
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
			...(willRetry ? [] : [listedThreadChanged(workspaceId, podId, threadId)]),
		],
		TurnCancelled: ({ threadId, workspaceId, podId, turnId, messageId, content }) => [
			onThread(
				threadId,
				streamEvent("message.completed", { threadId, messageId, content, status: "cancelled" }),
			),
			onThread(threadId, streamEvent("turn.completed", { threadId, turnId, status: "cancelled" })),
			listedThreadChanged(workspaceId, podId, threadId),
		],
		TurnCancelRequested: ({ threadId, turnId }) => [
			onThread(threadId, streamEvent("turn.cancel_requested", { threadId, turnId })),
		],
		// Nobody is shown a turn given up as cancelled: it was not wanted any more.
		TurnAbandoned: ({ threadId, outcome }) =>
			outcome.state === "failed" ? [notice(threadId, outcome.error)] : [],
		// Watchers see nothing new in this; only routine settlement reacts to it.
		LaneReleased: () => [],
		FacilitationFailed: ({ threadId, userMessage }) => [notice(threadId, userMessage)],
		ToolCallStarted: (change) => [toolCallEvent("tool_call.started", change)],
		ToolCallDecided: (change) => [
			toolCallEvent("tool_call.updated", change),
			listedThreadChanged(change.workspaceId, change.podId, change.threadId),
		],
		ToolCallExecuting: (change) => [toolCallEvent("tool_call.updated", change)],
		ToolCallFinished: (change) => [toolCallEvent("tool_call.completed", change)],
		CollaborationOpened: (opened) => [
			collaborationUpdated(opened),
			listedThreadChanged(opened.workspaceId, opened.podId, opened.collaboration.threadId),
			...(opened.recipientChatId
				? [
						{
							channel: workspaceChannel(opened.workspaceId),
							event: PodAudience.forPod(
								opened.podId,
								streamEvent("chat.thread_changed", {
									chatId: opened.recipientChatId,
									threadId: opened.collaboration.threadId,
									threadType: "collaboration",
								}),
							),
						},
					]
				: []),
		],
		CollaborationStoppedWaiting: (change) => [collaborationUpdated(change)],
		CollaborationAnswered: (change) => [collaborationUpdated(change)],
		CollaborationFailed: (change) => [collaborationUpdated(change)],
		ThreadSummarised: ({ workspaceId, podId, threadId }) =>
			threadChanged(workspaceId, podId, threadId),
		ThreadCompacted: ({ workspaceId, podId, threadId }) =>
			threadChanged(workspaceId, podId, threadId),
		RoutineExecutionAccepted: ({ workspaceId, podId, chatId, threadId }) => [
			routineThreadChanged(workspaceId, podId, chatId, threadId),
		],
		RoutineWorkCancelled: ({ workspaceId, podId, threadIds }) =>
			threadIds.flatMap((threadId) => threadChanged(workspaceId, podId, threadId)),
		RoutineExecutionSettled: ({ workspaceId, podId, chatId, threadId }) => [
			routineThreadChanged(workspaceId, podId, chatId, threadId),
		],
	});
}

function onThread(threadId: string, event: PendingEvent["event"]): PendingEvent {
	return { channel: threadChannel(threadId), event };
}

/** Tells the thread's watchers why a reply they may be waiting for is not coming. */
function notice(threadId: string, userMessage: UserMessage): PendingEvent {
	return onThread(threadId, streamEvent("thread.notice", { threadId, notice: userMessage }));
}

/** For a change no more specific event on the thread's channel describes. */
function threadChanged(workspaceId: string, podId: string, threadId: string): PendingEvent[] {
	return [
		onThread(threadId, streamEvent("thread.changed", { threadId })),
		listedThreadChanged(workspaceId, podId, threadId),
	];
}

function listedThreadChanged(workspaceId: string, podId: string, threadId: string): PendingEvent {
	return {
		channel: workspaceChannel(workspaceId),
		event: PodAudience.forPod(podId, streamEvent("thread.changed", { threadId })),
	};
}

function routineThreadChanged(
	workspaceId: string,
	podId: string,
	chatId: string,
	threadId: string,
): PendingEvent {
	return {
		channel: workspaceChannel(workspaceId),
		event: PodAudience.forPod(
			podId,
			streamEvent("chat.thread_changed", { chatId, threadId, threadType: "routine" }),
		),
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
