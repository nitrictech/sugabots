import {
	type CollaborationPart,
	chatStream,
	type ToolCallPart,
	workspaceStream,
} from "@sugabots/contracts";
import { testPerson } from "@sugabots/contracts/testing";
import { userText } from "@sugabots/errors";
import { Effect } from "effect";
import { beforeEach, describe, expect, it } from "vitest";
import { transaction } from "../database/database.ts";
import { Audience } from "../database/events/audience.ts";
import type { PendingEvent } from "../database/events/outbox.ts";
import { noDatabase } from "../database/testing.ts";
import { ChatEventStream } from "./chat-event-stream.ts";
import { ChatEvent } from "./events.ts";

/**
 * The stream rule: a chat's events go on its own stream, and the
 * workspace stream hears `chat.changed` naming the chat when its lists
 * may be out of date.
 */
describe("the chat feed", () => {
	let published: PendingEvent[] = [];
	const feed = ChatEventStream.handler({
		publish: (pending) =>
			Effect.sync(() => {
				published.push(...pending);
			}),
	});
	const workspaceId = crypto.randomUUID();
	const chatId = crypto.randomUUID();
	const turnId = crypto.randomUUID();
	const botId = crypto.randomUUID();

	beforeEach(() => {
		published = [];
	});

	const sent = (...events: ChatEvent[]) => {
		Effect.runSync(transaction(feed(events)).pipe(Effect.provide(noDatabase)));
		return published;
	};

	it("puts a completed turn on its chat and names the chat to the workspace", () => {
		expect(
			sent(
				ChatEvent.TurnCompleted({
					chatId,
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
				stream: chatStream(chatId),
				event: expect.objectContaining({
					type: "message.completed",
					chatId,
					messageId: "m1",
					content: "Done.",
					status: "complete",
				}),
			},
			{
				stream: chatStream(chatId),
				event: expect.objectContaining({ type: "turn.completed", turnId, status: "done" }),
			},
			{
				stream: workspaceStream(workspaceId),
				event: expect.objectContaining({ type: "chat.changed", chatId }),
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
					ChatEvent.TurnFailed({
						chatId,
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
					stream: chatStream(chatId),
					event: expect.objectContaining({
						type: "message.failed",
						chatId,
						messageId: "m1",
						turnId,
						error: userMessage,
					}),
				},
				...(listsChange
					? [
							{
								stream: workspaceStream(workspaceId),
								event: expect.objectContaining({ type: "chat.changed", chatId }),
							},
						]
					: []),
			]);
		},
	);

	it("ends a cancelled or abandoned reply, so it stops showing as being written", () => {
		expect(
			sent(
				ChatEvent.TurnCancelled({
					chatId,
					workspaceId,
					turnId,
					botId,
					messageId: "m1",
					content: "Half a thou",
				}),
			),
		).toEqual([
			{
				stream: chatStream(chatId),
				event: expect.objectContaining({
					type: "message.completed",
					messageId: "m1",
					content: "Half a thou",
					status: "cancelled",
				}),
			},
			{
				stream: chatStream(chatId),
				event: expect.objectContaining({ type: "turn.completed", turnId, status: "cancelled" }),
			},
			{
				stream: workspaceStream(workspaceId),
				event: expect.objectContaining({ type: "chat.changed", chatId }),
			},
		]);
	});

	it("names the chat on everything it tells the workspace, and on nothing else", () => {
		const told = sent(
			ChatEvent.TurnCancelled({
				chatId,
				workspaceId,
				turnId,
				botId,
				messageId: "m1",
				content: "",
			}),
		);

		expect(told.map(({ stream, event }) => [stream, Audience.read(event).audience])).toEqual([
			[chatStream(chatId), undefined],
			[chatStream(chatId), undefined],
			[workspaceStream(workspaceId), { kind: "chat", chatId }],
		]);
	});

	it("tells the chat why a reply it asked for is not coming", () => {
		const noModel = userText`Ada has no model chosen, so it cannot reply.`;

		expect(
			sent(
				ChatEvent.TurnAbandoned({
					chatId,
					botId,
					outcome: { state: "failed", error: noModel },
				}),
			),
		).toEqual([
			// Nothing waits for the turn any more.
			{
				stream: chatStream(chatId),
				event: expect.objectContaining({ type: "chat.changed", chatId }),
			},
			{
				stream: chatStream(chatId),
				event: expect.objectContaining({
					type: "chat.notice",
					chatId,
					notice: noModel,
				}),
			},
		]);
	});

	it("shows nothing of a turn given up as cancelled", () => {
		expect(
			sent(ChatEvent.TurnAbandoned({ chatId, botId, outcome: { state: "cancelled" } })),
		).toEqual([]);
	});

	it("tells the reply's chat how each tool call stands", () => {
		const change = { chatId, messageId: "m1", toolCall };
		const onChat = (type: string) => ({
			stream: chatStream(chatId),
			event: expect.objectContaining({ type, chatId, messageId: "m1", toolCall }),
		});

		expect(
			sent(
				ChatEvent.ToolCallStarted(change),
				ChatEvent.ToolCallDecided({ ...change, workspaceId }),
				ChatEvent.ToolCallExecuting(change),
				ChatEvent.ToolCallFinished(change),
			),
		).toEqual([
			onChat("tool_call.started"),
			onChat("tool_call.updated"),
			// A decided call waits on nobody any more, which the lists show.
			{
				stream: workspaceStream(workspaceId),
				event: expect.objectContaining({ type: "chat.changed", chatId }),
			},
			onChat("tool_call.updated"),
			onChat("tool_call.completed"),
		]);
	});

	it("tells the lists of a posted message, as well as its chat", () => {
		const posted = sent(
			ChatEvent.MessagePosted({
				chatId,
				workspaceId,
				message: {
					id: "m1",
					chatId,
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
				stream: chatStream(chatId),
				event: expect.objectContaining({ type: "message.created", chatId }),
			},
			{
				stream: workspaceStream(workspaceId),
				event: expect.objectContaining({ type: "chat.changed", chatId }),
			},
		]);
	});

	it("shows an opened collaboration in the asking reply, and lists its chat", () => {
		expect(
			sent(
				ChatEvent.CollaborationOpened({
					parentChatId: chatId,
					parentMessageId: "m1",
					collaboration,
					workspaceId,
					collaboratorBotId: "a1",
					briefMessageId: "m2",
				}),
			),
		).toEqual([
			{
				stream: chatStream(chatId),
				event: expect.objectContaining({
					type: "collaboration.updated",
					chatId,
					messageId: "m1",
					collaboration,
				}),
			},
			{
				stream: workspaceStream(workspaceId),
				event: expect.objectContaining({
					type: "chat.changed",
					chatId: collaboration.chatId,
				}),
			},
		]);
	});

	it("tells each chat a cancelled automation run touched, and the workspace, which chat changed", () => {
		const childId = crypto.randomUUID();

		expect(
			sent(
				ChatEvent.AutomationWorkCancelled({
					workspaceId,
					chatIds: [chatId, childId],
				}),
			),
		).toEqual(
			[chatId, childId].flatMap((id) => [
				{
					stream: chatStream(id),
					event: expect.objectContaining({ type: "chat.changed", chatId: id }),
				},
				{
					stream: workspaceStream(workspaceId),
					event: expect.objectContaining({ type: "chat.changed", chatId: id }),
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
	writeOrDelete: false,
	atOffset: 4,
	startedAt: new Date().toISOString(),
	finishedAt: null,
};

const collaboration: CollaborationPart = {
	type: "collaboration",
	id: crypto.randomUUID(),
	botId: crypto.randomUUID(),
	botName: "Helper",
	chatId: crypto.randomUUID(),
	brief: "Look",
	status: "waiting",
	answer: null,
	atOffset: 4,
};
