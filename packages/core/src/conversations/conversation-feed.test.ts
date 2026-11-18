import {
	type CollaborationPart,
	conversationChannel,
	type ToolCallPart,
	workspaceChannel,
} from "@sugabots/contracts";
import { testPerson } from "@sugabots/contracts/testing";
import { userText } from "@sugabots/errors";
import { Effect } from "effect";
import { beforeEach, describe, expect, it } from "vitest";
import { transaction } from "../database/database.ts";
import { Audience } from "../database/events/audience.ts";
import type { PendingEvent } from "../database/events/outbox.ts";
import { noDatabase } from "../database/testing.ts";
import { ConversationFeed } from "./conversation-feed.ts";
import { ConversationEvent } from "./events.ts";

/**
 * The channel rule: a conversation's events go on its own channel, and the
 * workspace channel hears `conversation.changed` naming the conversation when its lists
 * may be out of date.
 */
describe("the conversation feed", () => {
	let published: PendingEvent[] = [];
	const feed = ConversationFeed.handler({
		publish: (pending) =>
			Effect.sync(() => {
				published.push(...pending);
			}),
	});
	const workspaceId = crypto.randomUUID();
	const conversationId = crypto.randomUUID();
	const turnId = crypto.randomUUID();
	const botId = crypto.randomUUID();

	beforeEach(() => {
		published = [];
	});

	const sent = (...events: ConversationEvent[]) => {
		Effect.runSync(transaction(feed(events)).pipe(Effect.provide(noDatabase)));
		return published;
	};

	it("puts a completed turn on its conversation and names the conversation to the workspace", () => {
		expect(
			sent(
				ConversationEvent.TurnCompleted({
					conversationId,
					workspaceId,
					turnId,
					botId,
					messageId: "m1",
					content: "Done.",
					contextTokens: undefined,
					contextCapacity: 128_000,
					readKeptFrom: null,
				}),
			),
		).toEqual([
			{
				channel: conversationChannel(conversationId),
				event: expect.objectContaining({
					type: "message.completed",
					conversationId,
					messageId: "m1",
					content: "Done.",
					status: "complete",
				}),
			},
			{
				channel: conversationChannel(conversationId),
				event: expect.objectContaining({ type: "turn.completed", turnId, status: "done" }),
			},
			{
				channel: workspaceChannel(workspaceId),
				event: expect.objectContaining({ type: "conversation.changed", conversationId }),
			},
		]);
	});

	it.each([
		{ willRetry: true, listsChange: false },
		{ willRetry: false, listsChange: true },
	])(
		"fails the reply with what people are told (will retry: $willRetry)",
		({ willRetry, listsChange }) => {
			const userMessage = userText`The model could not be reached`;

			expect(
				sent(
					ConversationEvent.TurnFailed({
						conversationId,
						workspaceId,
						turnId,
						botId,
						messageId: "m1",
						userMessage,
						willRetry,
					}),
				),
			).toEqual([
				{
					channel: conversationChannel(conversationId),
					event: expect.objectContaining({
						type: "message.failed",
						conversationId,
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
								event: expect.objectContaining({ type: "conversation.changed", conversationId }),
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
					conversationId,
					workspaceId,
					turnId,
					botId,
					messageId: "m1",
					content: "Half a thou",
				}),
			),
		).toEqual([
			{
				channel: conversationChannel(conversationId),
				event: expect.objectContaining({
					type: "message.completed",
					messageId: "m1",
					content: "Half a thou",
					status: "cancelled",
				}),
			},
			{
				channel: conversationChannel(conversationId),
				event: expect.objectContaining({ type: "turn.completed", turnId, status: "cancelled" }),
			},
			{
				channel: workspaceChannel(workspaceId),
				event: expect.objectContaining({ type: "conversation.changed", conversationId }),
			},
		]);
	});

	it("names the conversation on everything it tells the workspace, and on nothing else", () => {
		const told = sent(
			ConversationEvent.TurnCancelled({
				conversationId,
				workspaceId,
				turnId,
				botId,
				messageId: "m1",
				content: "",
			}),
		);

		expect(told.map(({ channel, event }) => [channel, Audience.read(event).audience])).toEqual([
			[conversationChannel(conversationId), undefined],
			[conversationChannel(conversationId), undefined],
			[workspaceChannel(workspaceId), { kind: "conversation", conversationId }],
		]);
	});

	it("tells the conversation why a reply it asked for is not coming", () => {
		const noModel = userText`Ada has no model chosen, so it cannot reply.`;

		expect(
			sent(
				ConversationEvent.TurnAbandoned({
					conversationId,
					botId,
					outcome: { state: "failed", error: noModel },
				}),
			),
		).toEqual([
			// Nothing waits for the turn any more.
			{
				channel: conversationChannel(conversationId),
				event: expect.objectContaining({ type: "conversation.changed", conversationId }),
			},
			{
				channel: conversationChannel(conversationId),
				event: expect.objectContaining({
					type: "conversation.notice",
					conversationId,
					notice: noModel,
				}),
			},
		]);
	});

	it("shows nothing of a turn given up as cancelled", () => {
		expect(
			sent(
				ConversationEvent.TurnAbandoned({ conversationId, botId, outcome: { state: "cancelled" } }),
			),
		).toEqual([]);
	});

	it("tells the reply's conversation how each tool call stands", () => {
		const change = { conversationId, messageId: "m1", toolCall };
		const onConversation = (type: string) => ({
			channel: conversationChannel(conversationId),
			event: expect.objectContaining({ type, conversationId, messageId: "m1", toolCall }),
		});

		expect(
			sent(
				ConversationEvent.ToolCallStarted(change),
				ConversationEvent.ToolCallDecided({ ...change, workspaceId }),
				ConversationEvent.ToolCallExecuting(change),
				ConversationEvent.ToolCallFinished(change),
			),
		).toEqual([
			onConversation("tool_call.started"),
			onConversation("tool_call.updated"),
			// A decided call waits on nobody any more, which the lists show.
			{
				channel: workspaceChannel(workspaceId),
				event: expect.objectContaining({ type: "conversation.changed", conversationId }),
			},
			onConversation("tool_call.updated"),
			onConversation("tool_call.completed"),
		]);
	});

	it("tells the lists of a posted message, as well as its conversation", () => {
		const posted = sent(
			ConversationEvent.MessagePosted({
				conversationId,
				workspaceId,
				message: {
					id: "m1",
					conversationId,
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
				channel: conversationChannel(conversationId),
				event: expect.objectContaining({ type: "message.created", conversationId }),
			},
			{
				channel: workspaceChannel(workspaceId),
				event: expect.objectContaining({ type: "conversation.changed", conversationId }),
			},
		]);
	});

	it("shows an opened collaboration in the asking reply, and lists its task", () => {
		expect(
			sent(
				ConversationEvent.CollaborationOpened({
					parentConversationId: conversationId,
					parentMessageId: "m1",
					collaboration,
					workspaceId,
					collaboratorBotId: "a1",
					briefMessageId: "m2",
				}),
			),
		).toEqual([
			{
				channel: conversationChannel(conversationId),
				event: expect.objectContaining({
					type: "collaboration.updated",
					conversationId,
					messageId: "m1",
					collaboration,
				}),
			},
			{
				channel: workspaceChannel(workspaceId),
				event: expect.objectContaining({
					type: "conversation.changed",
					conversationId: collaboration.conversationId,
				}),
			},
		]);
	});

	it("tells each conversation a cancelled automation run touched, and the workspace, which conversation changed", () => {
		const childId = crypto.randomUUID();

		expect(
			sent(
				ConversationEvent.AutomationWorkCancelled({
					workspaceId,
					conversationIds: [conversationId, childId],
				}),
			),
		).toEqual(
			[conversationId, childId].flatMap((id) => [
				{
					channel: conversationChannel(id),
					event: expect.objectContaining({ type: "conversation.changed", conversationId: id }),
				},
				{
					channel: workspaceChannel(workspaceId),
					event: expect.objectContaining({ type: "conversation.changed", conversationId: id }),
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
	botId: crypto.randomUUID(),
	botName: "Helper",
	conversationId: crypto.randomUUID(),
	brief: "Look",
	status: "waiting",
	answer: null,
	atOffset: 4,
};
