import {
	type CollaborationPart,
	type ToolCallPart,
	threadChannel,
	workspaceChannel,
} from "@sugabots/contracts";
import { Effect } from "effect";
import { beforeEach, describe, expect, it } from "vitest";
import { transaction } from "../database/database.ts";
import type { PendingEvent } from "../database/events/outbox.ts";
import { noDatabase } from "../database/testing.ts";
import { UserMessage } from "../user-message.ts";
import { ConversationEvent } from "./events.ts";
import { ThreadFeed } from "./thread-feed.ts";

/**
 * The channel rule: a thread's events go on its own channel, and the
 * workspace channel hears `thread.changed` naming the thread when its lists
 * may be out of date.
 */
describe("the thread feed", () => {
	let published: PendingEvent[] = [];
	const feed = ThreadFeed.handler({
		publish: (pending) =>
			Effect.sync(() => {
				published.push(...pending);
			}),
	});
	const workspaceId = crypto.randomUUID();
	const threadId = crypto.randomUUID();
	const turnId = crypto.randomUUID();
	const agentId = crypto.randomUUID();

	beforeEach(() => {
		published = [];
	});

	const sent = (...events: ConversationEvent[]) => {
		Effect.runSync(transaction(feed(events)).pipe(Effect.provide(noDatabase)));
		return published;
	};

	it("puts a completed turn on its thread and names the thread to the workspace", () => {
		expect(
			sent(
				ConversationEvent.TurnCompleted({
					threadId,
					workspaceId,
					turnId,
					messageId: "m1",
					content: "Done.",
					usage: { modelCalls: 1 },
					reportedCost: undefined,
				}),
			),
		).toEqual([
			{
				channel: threadChannel(threadId),
				event: expect.objectContaining({
					type: "message.completed",
					threadId,
					messageId: "m1",
					content: "Done.",
					status: "complete",
				}),
			},
			{
				channel: threadChannel(threadId),
				event: expect.objectContaining({ type: "turn.completed", turnId, status: "done" }),
			},
			{
				channel: workspaceChannel(workspaceId),
				event: expect.objectContaining({ type: "thread.changed", threadId }),
			},
		]);
	});

	it.each([
		{ willRetry: true, listsChange: false },
		{ willRetry: false, listsChange: true },
	])(
		"fails the reply with what people are told (will retry: $willRetry)",
		({ willRetry, listsChange }) => {
			const userMessage = UserMessage.of`The model could not be reached`;

			expect(
				sent(
					ConversationEvent.TurnFailed({
						threadId,
						workspaceId,
						turnId,
						agentId,
						messageId: "m1",
						userMessage,
						willRetry,
					}),
				),
			).toEqual([
				{
					channel: threadChannel(threadId),
					event: expect.objectContaining({
						type: "message.failed",
						threadId,
						messageId: "m1",
						turnId,
						willRetry,
						error: userMessage,
					}),
				},
				...(listsChange
					? [
							{
								channel: workspaceChannel(workspaceId),
								event: expect.objectContaining({ type: "thread.changed", threadId }),
							},
						]
					: []),
			]);
		},
	);

	it("ends a cancelled or abandoned reply, so it stops showing as streaming", () => {
		expect(
			sent(
				ConversationEvent.TurnCancelled({
					threadId,
					workspaceId,
					turnId,
					agentId,
					messageId: "m1",
					content: "Half a thou",
				}),
			),
		).toEqual([
			{
				channel: threadChannel(threadId),
				event: expect.objectContaining({
					type: "message.completed",
					messageId: "m1",
					content: "Half a thou",
					status: "cancelled",
				}),
			},
			{
				channel: threadChannel(threadId),
				event: expect.objectContaining({ type: "turn.completed", turnId, status: "cancelled" }),
			},
			{
				channel: workspaceChannel(workspaceId),
				event: expect.objectContaining({ type: "thread.changed", threadId }),
			},
		]);
	});

	it("tells the reply's thread how each tool call stands", () => {
		const change = { threadId, messageId: "m1", toolCall };

		expect(
			sent(
				ConversationEvent.ToolCallStarted(change),
				ConversationEvent.ToolCallDecided(change),
				ConversationEvent.ToolCallExecuting(change),
				ConversationEvent.ToolCallFinished(change),
			),
		).toEqual(
			["tool_call.started", "tool_call.updated", "tool_call.updated", "tool_call.completed"].map(
				(type) => ({
					channel: threadChannel(threadId),
					event: expect.objectContaining({ type, threadId, messageId: "m1", toolCall }),
				}),
			),
		);
	});

	it.each([
		{ recipientChatId: crypto.randomUUID(), listed: "in the collaborator's chat" },
		{ recipientChatId: null, listed: "nowhere else" },
	])("shows an opened collaboration in the asking reply, listed $listed", ({ recipientChatId }) => {
		expect(
			sent(
				ConversationEvent.CollaborationOpened({
					parentThreadId: threadId,
					parentMessageId: "m1",
					collaboration,
					workspaceId,
					recipientChatId,
				}),
			),
		).toEqual([
			{
				channel: threadChannel(threadId),
				event: expect.objectContaining({
					type: "collaboration.updated",
					threadId,
					messageId: "m1",
					collaboration,
				}),
			},
			{
				channel: workspaceChannel(workspaceId),
				event: expect.objectContaining({
					type: "thread.changed",
					threadId: collaboration.threadId,
				}),
			},
			...(recipientChatId
				? [
						{
							channel: workspaceChannel(workspaceId),
							event: expect.objectContaining({
								type: "chat.thread_changed",
								chatId: recipientChatId,
								threadId: collaboration.threadId,
								threadType: "collaboration",
							}),
						},
					]
				: []),
		]);
	});

	it("tells each thread a cancelled routine run touched, and the workspace, which thread changed", () => {
		const childId = crypto.randomUUID();

		expect(
			sent(ConversationEvent.RoutineWorkCancelled({ workspaceId, threadIds: [threadId, childId] })),
		).toEqual(
			[threadId, childId].flatMap((id) => [
				{
					channel: threadChannel(id),
					event: expect.objectContaining({ type: "thread.changed", threadId: id }),
				},
				{
					channel: workspaceChannel(workspaceId),
					event: expect.objectContaining({ type: "thread.changed", threadId: id }),
				},
			]),
		);
	});
});

const toolCall: ToolCallPart = {
	type: "tool_call",
	id: crypto.randomUUID(),
	tool: "web_fetch",
	input: { url: "https://example.com" },
	output: null,
	status: "running",
	approval: { status: "allowed", decidedByName: "Ada", decidedAt: new Date().toISOString() },
	error: null,
	mutating: false,
	atOffset: 4,
	startedAt: new Date().toISOString(),
	finishedAt: null,
};

const collaboration: CollaborationPart = {
	type: "collaboration",
	id: crypto.randomUUID(),
	agentId: crypto.randomUUID(),
	agentName: "Helper",
	threadId: crypto.randomUUID(),
	brief: "Look",
	status: "waiting",
	answer: null,
	atOffset: 4,
};
