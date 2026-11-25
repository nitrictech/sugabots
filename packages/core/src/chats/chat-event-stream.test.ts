import { chatStream, type ToolCallPart, workspaceStream } from "@sugabots/contracts";
import { testMember } from "@sugabots/contracts/testing";
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
describe("the chat event stream", () => {
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
					finishedAt: new Date("2026-11-23T10:00:00Z"),
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
					finishedAt: "2026-11-23T10:00:00.000Z",
				}),
			},
			{
				stream: chatStream(chatId),
				event: expect.objectContaining({ type: "turn.completed", chatId }),
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
		"fails the reply with what members are told (will retry: $willRetry)",
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

	it("ends a cancelled reply, so it stops showing as being written, naming the chat only to the workspace", () => {
		const told = sent(
			ChatEvent.TurnInterrupted({
				chatId,
				workspaceId,
				turnId,
				botId,
				messageId: "m1",
				content: "Half a thou",
				finishedAt: new Date("2026-11-23T10:00:00Z"),
			}),
		);

		expect(told).toEqual([
			{
				stream: chatStream(chatId),
				event: expect.objectContaining({
					type: "message.completed",
					messageId: "m1",
					content: "Half a thou",
					status: "cancelled",
					finishedAt: "2026-11-23T10:00:00.000Z",
				}),
			},
			{
				stream: chatStream(chatId),
				event: expect.objectContaining({ type: "turn.completed", chatId }),
			},
			{
				stream: workspaceStream(workspaceId),
				event: expect.objectContaining({ type: "chat.changed", chatId }),
			},
		]);
		expect(told.map(({ stream, event }) => [stream, Audience.read(event).audience])).toEqual([
			[chatStream(chatId), undefined],
			[chatStream(chatId), undefined],
			[workspaceStream(workspaceId), { kind: "chat", chat: chatId }],
		]);
	});

	it("tells the chat why a reply it asked for is not coming", () => {
		const noModel = userText`Ada has no model chosen, so it cannot reply.`;

		expect(
			sent(
				ChatEvent.TurnAbandoned({
					chatId,
					botId,
					triggerMessageId: crypto.randomUUID(),
					reason: "mention",
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
			sent(
				ChatEvent.TurnAbandoned({
					chatId,
					botId,
					triggerMessageId: crypto.randomUUID(),
					reason: "mention",
					outcome: { state: "cancelled" },
				}),
			),
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
					author: testMember({ id: "u1", name: "Sam" }),
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

	it("tells the chat of a cancelled automation run, and the workspace, that it changed", () => {
		expect(sent(ChatEvent.AutomationWorkCancelled({ workspaceId, chatId }))).toEqual([
			{
				stream: chatStream(chatId),
				event: expect.objectContaining({ type: "chat.changed", chatId }),
			},
			{
				stream: workspaceStream(workspaceId),
				event: expect.objectContaining({ type: "chat.changed", chatId }),
			},
		]);
	});
});

const toolCall: ToolCallPart = {
	type: "tool_call",
	id: crypto.randomUUID(),
	tool: "web_fetch",
	input: { url: "https://example.com" },
	output: null,
	status: "running",
	approval: {
		status: "allowed",
		approvers: "chat",
		decidedByName: "Ada",
		decidedAt: new Date().toISOString(),
	},
	error: null,
	atOffset: 4,
	startedAt: new Date().toISOString(),
	finishedAt: null,
};
