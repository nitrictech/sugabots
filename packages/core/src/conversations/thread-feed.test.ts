import {
	type CollaborationPart,
	type ToolCallPart,
	threadChannel,
	workspaceChannel,
} from "@sugabots/contracts";
import { testPerson } from "@sugabots/contracts/testing";
import { Effect } from "effect";
import { beforeEach, describe, expect, it } from "vitest";
import { transaction } from "../database/database.ts";
import type { PendingEvent } from "../database/events/outbox.ts";
import { PodAudience } from "../database/events/pod-audience.ts";
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
	const podId = crypto.randomUUID();

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
					podId,
					turnId,
					agentId,
					reason: undefined,
					messageId: "m1",
					content: "Done.",
					contextTokens: undefined,
					contextCapacity: 128_000,
					readKeptFrom: null,
					answeredCollaboration: false,
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
						podId,
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
					podId,
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

	it("names the thread's pod on everything it tells the workspace, and on nothing else", () => {
		const told = sent(
			ConversationEvent.TurnCancelled({
				threadId,
				workspaceId,
				podId,
				turnId,
				agentId,
				messageId: "m1",
				content: "",
			}),
		);

		expect(
			told.map(({ channel, event }) => [channel, PodAudience.audienceOf(event).podId]),
		).toEqual([
			[threadChannel(threadId), undefined],
			[threadChannel(threadId), undefined],
			[workspaceChannel(workspaceId), podId],
		]);
	});

	it("tells the thread why a reply it asked for is not coming", () => {
		const noModel = UserMessage.of`Ada has no model chosen, so it cannot reply.`;
		const noChoice = UserMessage.of`The Facilitator could not choose who speaks next`;

		expect(
			sent(
				ConversationEvent.TurnAbandoned({
					threadId,
					agentId,
					outcome: { state: "failed", error: noModel },
				}),
				ConversationEvent.FacilitationFailed({ threadId, userMessage: noChoice }),
			),
		).toEqual([
			// Nothing waits for the turn any more.
			{
				channel: threadChannel(threadId),
				event: expect.objectContaining({ type: "thread.changed", threadId }),
			},
			{
				channel: threadChannel(threadId),
				event: expect.objectContaining({ type: "thread.notice", threadId, notice: noModel }),
			},
			{
				channel: threadChannel(threadId),
				event: expect.objectContaining({ type: "thread.notice", threadId, notice: noChoice }),
			},
		]);
	});

	it("shows nothing of a turn given up as cancelled", () => {
		expect(
			sent(ConversationEvent.TurnAbandoned({ threadId, agentId, outcome: { state: "cancelled" } })),
		).toEqual([]);
	});

	it("tells the reply's thread how each tool call stands", () => {
		const change = { threadId, messageId: "m1", toolCall };
		const onThread = (type: string) => ({
			channel: threadChannel(threadId),
			event: expect.objectContaining({ type, threadId, messageId: "m1", toolCall }),
		});

		expect(
			sent(
				ConversationEvent.ToolCallStarted(change),
				ConversationEvent.ToolCallDecided({ ...change, workspaceId, podId }),
				ConversationEvent.ToolCallExecuting(change),
				ConversationEvent.ToolCallFinished(change),
			),
		).toEqual([
			onThread("tool_call.started"),
			onThread("tool_call.updated"),
			// A decided call waits on nobody any more, which the lists show.
			{
				channel: workspaceChannel(workspaceId),
				event: expect.objectContaining({ type: "thread.changed", threadId }),
			},
			onThread("tool_call.updated"),
			onThread("tool_call.completed"),
		]);
	});

	it("tells the lists of a posted message, as well as its thread", () => {
		const posted = sent(
			ConversationEvent.MessagePosted({
				threadId,
				workspaceId,
				podId,
				message: {
					id: "m1",
					threadId,
					author: testPerson({ id: "u1", name: "Sam" }),
					kind: "text",
					status: "complete",
					parts: [{ type: "text", text: "Hi" }],
					content: "Hi",
					createdAt: new Date(0).toISOString(),
				},
			}),
		);

		expect(posted).toEqual([
			{
				channel: threadChannel(threadId),
				event: expect.objectContaining({ type: "message.created", threadId }),
			},
			{
				channel: workspaceChannel(workspaceId),
				event: expect.objectContaining({ type: "thread.changed", threadId }),
			},
		]);
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
					podId,
					recipientChatId,
					collaboratorAgentId: "a1",
					briefMessageId: "m2",
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
			sent(
				ConversationEvent.RoutineWorkCancelled({
					workspaceId,
					podId,
					threadIds: [threadId, childId],
				}),
			),
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
