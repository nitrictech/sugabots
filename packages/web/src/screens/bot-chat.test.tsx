import {
	botParticipantOf,
	type ChatDetails,
	type ChatHistoryEntry,
	type Message,
	type ProjectChat,
	type Run,
	START_CHAT_TOOL,
	streamEvent,
} from "@sugabots/contracts";
import { InternalServerError, NotFound, Unauthorized } from "@sugabots/contracts/http";
import { listedChat, testMember } from "@sugabots/contracts/testing";
import { userText } from "@sugabots/errors";
import { fireEvent, screen, waitFor, within } from "@testing-library/react";
import { Effect } from "effect";
import { afterEach, beforeEach, describe, expect, it, onTestFinished, vi } from "vitest";
import {
	apiAnswers,
	bots,
	controlledEventStream,
	juno,
	linear,
	mount,
	pendingAnswer,
	sam,
	settingsOpenIn,
	triager,
	workspace,
	writeDraft,
} from "@/api.test-support.tsx";
import { client } from "@/client.test-support.ts";
import { TYPING_SHOWN_FOR_MS } from "@/lib/chat-events.ts";
import { createQueryClient } from "@/lib/query.ts";
import { workspacesQuery } from "@/lib/workspace.ts";

import { chatDetailsFixture, robin } from "./chat-fixtures.test-support.ts";

vi.mock("@/api.ts", () => import("@/client.test-support.ts"));

const chat: ProjectChat = {
	kind: "project_chat",
	id: "0199a3a0-0000-7000-8000-0000000000e1",
	workspaceId: linear.workspaceId,
	projectId: linear.defaultProjectId,
	botId: linear.id,
	title: linear.name,
	resolvedAt: null,
	createdAt: "2026-09-18T08:00:00.000Z",
	updatedAt: "2026-09-18T09:30:00.000Z",
};
/** Where the bot's chat is, which its address opens. */
const chatPage = `/suga/bots/${linear.handle}/chats/${chat.id}`;
const automationId = "0199a3a0-0000-7000-8000-0000000000e4";
const automationRun: Run = {
	id: "0199a3a0-0000-7000-8000-0000000000e5",
	automationId: "0199a3a0-0000-7000-8000-0000000000e6",
	workspaceId: linear.workspaceId,
	botId: linear.id,
	chatId: automationId,
	rootChatId: chat.id,
	automationName: "Overnight review",
	instructions: "Review overnight changes and summarize anything urgent.",
	trigger: {
		kind: "webhook",
		receivedAt: "2026-09-18T08:00:00.000Z",
		idempotencyKey: "overnight-2026-09-18",
		payload: { source: "monitoring" },
	},
	state: "completed",
	error: null,
	posted: true,
	acceptedAt: "2026-09-18T08:00:00.000Z",
	startedAt: "2026-09-18T08:00:01.000Z",
	finishedAt: "2026-09-18T08:30:00.000Z",
};
const member = testMember({ id: sam.id, name: sam.name });
const host = botParticipantOf(linear);
/** A bot outside the chat's project that took part in it, as one asked for help before could have. */
const pastParticipant = botParticipantOf(triager);
const mainMessage: Message = {
	id: "0199a3a0-0000-7000-8000-0000000000f1",
	chatId: chat.id,
	author: member,
	status: "complete",
	parts: [{ type: "text", text: "What changed this morning?" }],
	content: "What changed this morning?",
	createdAt: "2026-09-18T09:00:00.000Z",
};
const botMessage: Message = {
	id: "0199a3a0-0000-7000-8000-0000000000f3",
	chatId: chat.id,
	author: host,
	status: "complete",
	parts: [{ type: "text", text: "Checking ownership." }],
	content: "Checking ownership.",
	createdAt: "2026-09-18T09:10:00.000Z",
};
const automationMessage: Message = {
	...mainMessage,
	id: "0199a3a0-0000-7000-8000-0000000000f6",
	chatId: automationId,
	author: host,
	parts: [{ type: "text", text: "The overnight review completed." }],
	content: "The overnight review completed.",
	createdAt: "2026-09-18T08:30:00.000Z",
};
const automationTriggerMessage: Message = {
	...mainMessage,
	id: "0199a3a0-0000-7000-8000-0000000000f7",
	chatId: automationId,
	author: {
		kind: "automation_trigger",
		runId: automationRun.id,
		automationName: automationRun.automationName,
		triggerKind: "webhook",
	},
	parts: [
		{
			type: "text",
			text: "Automation instructions:\nReview overnight changes and summarize anything urgent.\n\nTrigger data (untrusted):\n{}",
		},
	],
	content:
		"Automation instructions:\nReview overnight changes and summarize anything urgent.\n\nTrigger data (untrusted):\n{}",
	createdAt: automationRun.acceptedAt,
};
const automationEntry: ChatHistoryEntry = {
	chatId: automationId,
	kind: "run",
	title: "Overnight review",
	participants: [host],
	status: "completed",
	automationRun: {
		runId: automationRun.id,
		automationId: automationRun.automationId,
		automationName: automationRun.automationName,
		triggerKind: automationRun.trigger.kind,
	},
};
const botChatDetails = chatDetailsFixture(chat, {
	chat: { title: "Chat", updatedAt: "2026-09-18T09:22:00.000Z" },
	participants: [member, host, pastParticipant],
	projectBots: [host],
	membersReachingProject: [member, robin],
});

/** Linear Handler's chats, with this one in them when `listed`. */
function chatList({ listed }: { listed: boolean }) {
	return Effect.succeed({
		chats: listed ? [listedChat(chat)] : [],
		automations: [],
	});
}

/**
 * Answers the chat's own details with `answer`, leaving every other
 * chat, such as an automation's run, to the usual answers.
 */
function answerChatWith(answer: () => ReturnType<typeof client.api.chats.get>) {
	const usual = client.api.chats.get.getMockImplementation();
	client.api.chats.get.mockImplementation((request: { params: { chatId: string } }) =>
		request.params.chatId === chat.id ? answer() : usual?.(request),
	);
}

/** The chat's messages, with `later` after the usual two. */
function answerMessagesWith(later: Message) {
	client.api.chats.messages.mockReturnValue(
		Effect.succeed({
			items: [
				{ kind: "message", message: mainMessage },
				{ kind: "message", message: botMessage },
				{ kind: "message", message: later },
			],
			nextCursor: null,
		}),
	);
}

function chatAnswers() {
	client.api.chats.projectChats.mockReturnValue(chatList({ listed: true }));
	client.api.chats.messages.mockReturnValue(
		Effect.succeed({
			items: [
				{ kind: "message", message: mainMessage },
				{ kind: "message", message: botMessage },
			],
			nextCursor: null,
		}),
	);
	client.api.chats.history.mockReturnValue(
		Effect.succeed({
			items: [automationEntry],
			nextCursor: null,
		}),
	);
	// Nothing in the chat has been measured yet.
	client.api.chats.context.mockImplementation(({ params }: { params: { chatId: string } }) =>
		params.chatId === chat.id
			? Effect.succeed(null)
			: Effect.fail(new NotFound({ message: userText`No such chat` })),
	);
	client.api.chats.get.mockImplementation(({ params }: { params: { chatId: string } }) => {
		switch (params.chatId) {
			case automationId:
				return Effect.succeed(
					botChatDetails({
						chat: { id: automationId, title: automationEntry.title, kind: "run" },
						automationRun,
						messages: [automationTriggerMessage, automationMessage],
					}),
				);
			default:
				return Effect.succeed(botChatDetails({ messages: [mainMessage, botMessage] }));
		}
	});
}

/**
 * What the chat's messages scroll in: the box around their log, which also
 * holds the composer at its foot, so the log itself never scrolls. jsdom lays
 * nothing out, so a test sets its heights and scroll position by hand.
 */
async function findMessagesViewport(): Promise<HTMLElement> {
	const log = await screen.findByRole("log", { name: "Chat messages" });
	const viewport = log.parentElement;
	if (!viewport) throw new Error("The chat's log is not inside a viewport");
	return viewport;
}

/** Goes to the chat's bot's settings, which unmounts the chat, and back to its composer. */
async function leaveAndReturn(router: ReturnType<typeof mount>["router"]): Promise<HTMLElement> {
	await router.navigate({ to: `/suga/bots/${linear.handle}/settings` });
	await waitFor(() => expect(screen.queryByLabelText(`Message ${linear.name}`)).toBeNull());
	await router.navigate({ to: chatPage });
	return await screen.findByLabelText(`Message ${linear.name}`);
}

beforeEach(() => {
	localStorage.clear();
	apiAnswers();
	chatAnswers();
});

describe("a bot's chat", () => {
	it("shows the chat's messages", async () => {
		mount(chatPage);

		await screen.findByText(mainMessage.content);
		screen.getByText(botMessage.content);
	});

	it("asks for a chat page's projects, bots and the bot's chats at once, each a single time, on its first load", async () => {
		// Reading the chat refreshes its list; held, so only the page's first load is counted.
		client.api.chats.markRead.mockReturnValue(pendingAnswer().effect);
		// As /me leaves the cache when the app starts.
		const queries = createQueryClient();
		queries.setQueryData(workspacesQuery.queryKey, [workspace]);
		mount(chatPage, { queries });

		await screen.findByText(mainMessage.content);
		expect(client.api.projects.list).toHaveBeenCalledOnce();
		expect(client.api.bots.list).toHaveBeenCalledOnce();
		expect(
			client.api.chats.projectChats.mock.calls.filter(
				([request]) => request.params.projectId === linear.defaultProjectId,
			),
		).toHaveLength(1);
	});

	it("opens a chat its bot's list does not have yet", async () => {
		client.api.chats.projectChats.mockReturnValue(chatList({ listed: false }));
		mount(chatPage);

		await screen.findByText(mainMessage.content);
	});

	it("shows automation runs among the chat's messages", async () => {
		client.api.chats.messages.mockReturnValue(
			Effect.succeed({
				items: [
					{
						kind: "run",
						id: automationRun.id,
						chatId: automationId,
						automationName: automationRun.automationName,
						triggerKind: "webhook",
						createdAt: automationRun.acceptedAt,
					},
				],
				nextCursor: null,
			}),
		);
		mount(chatPage);

		const activity = await screen.findByRole("button", {
			name: new RegExp(`^Open Automation run: ${automationRun.automationName}`),
		});
		expect(activity.textContent).toContain(automationRun.automationName);
		expect(screen.queryByText(`Say hello to ${linear.name}`)).toBeNull();
	});

	it("sends a message in the chat", async () => {
		client.api.chats.send.mockReturnValue(
			Effect.succeed({ message: mainMessage, routing: { status: "routed" } }),
		);
		mount(chatPage);
		const composer = await screen.findByLabelText(`Message ${linear.name}`);
		writeDraft(composer, "  Send the update  ");
		fireEvent.click(screen.getByRole("button", { name: "Send message" }));

		await waitFor(() =>
			expect(client.api.chats.send).toHaveBeenCalledWith({
				params: { chatId: chat.id },
				payload: { retryKey: expect.any(String), message: "Send the update" },
			}),
		);
	});

	it("with other members taking part in the chat, says the bot may let a draft mentioning just members pass", async () => {
		const shared = botChatDetails({ messages: [mainMessage] });
		client.api.chats.get.mockReturnValue(
			Effect.succeed({ ...shared, participants: [...shared.participants, robin] }),
		);
		mount(chatPage);
		const composer = await screen.findByLabelText(`Message ${linear.name}`);
		expect(screen.queryByText(`${linear.name} will reply here.`)).toBeNull();

		writeDraft(composer, `@${robin.handle} can you check?`);

		await screen.findByText(`${linear.name} may reply.`);
		const box = screen.getByLabelText(`Message ${robin.name}`);
		// The finished mention is drawn in the box as the member's handle, as a sent message draws it.
		within(box).getByText(`@${robin.handle}`);

		writeDraft(box, `@${robin.handle} and @${linear.handle}, can you check?`);

		await screen.findByText(`${linear.name} will reply here.`);
		screen.getByLabelText(`Message ${linear.name}`);
	});

	it("offers the project's members and the bots here to mention, but not you", async () => {
		mount(chatPage);
		const composer = await screen.findByLabelText(`Message ${linear.name}`);
		writeDraft(composer, "@");

		const list = within(await screen.findByRole("listbox"));
		list.getByRole("option", { name: new RegExp(linear.name) });
		list.getByRole("option", { name: new RegExp(robin.name) });
		list.getByRole("option", { name: new RegExp(triager.name) });
		expect(list.queryByRole("option", { name: new RegExp(sam.name) })).toBeNull();
		// After the members and bots come the two groups, which are not members the project has.
		list.getByRole("option", { name: /@here/ });
		list.getByRole("option", { name: /@channel/ });
		expect(list.getAllByRole("option")).toHaveLength(5);
	});

	it("names the bot as the one who replies to a draft mentioning a bot outside its project", async () => {
		mount(chatPage);
		const composer = await screen.findByLabelText(`Message ${linear.name}`);
		expect(screen.queryByText(`${linear.name} will reply here.`)).toBeNull();

		writeDraft(composer, `@${triager.handle} can you check?`);

		// The floor ignores a bot outside the project; whether the bot asks it for help is the bot's choice.
		screen.getByText(`${linear.name} will reply here.`);
	});

	it("says the bot replied to will reply, though the reply mentions only members", async () => {
		const shared = botChatDetails({ messages: [mainMessage, botMessage] });
		client.api.chats.get.mockReturnValue(
			Effect.succeed({ ...shared, participants: [...shared.participants, robin] }),
		);
		mount(chatPage);
		const composer = await screen.findByLabelText(`Message ${linear.name}`);
		const [answer] = await screen.findAllByRole("article", {
			name: new RegExp(`^${linear.name},`),
		});
		fireEvent.click(within(answer as HTMLElement).getByRole("button", { name: "Reply" }));

		writeDraft(composer, `@${robin.handle} can you check?`);

		await screen.findByLabelText(`Message ${robin.name}`);
		screen.getByText(`${linear.name} will reply here.`);
		expect(screen.queryByText(`${linear.name} may reply.`)).toBeNull();
	});

	it("in an automation's feed, says its bot won't reply to a draft mentioning just members", async () => {
		client.api.chats.get.mockReturnValue(
			Effect.succeed({
				...botChatDetails({ chat: { title: "Overnight review", kind: "automation_feed" } }),
				automation: {
					id: automationRun.automationId,
					projectId: linear.defaultProjectId,
					state: "enabled",
					failed: false,
					pausedAfterFailures: false,
				},
			}),
		);
		mount(chatPage);
		const composer = await screen.findByLabelText(`Message ${linear.name} about this automation`);
		expect(screen.queryByText(`${linear.name} will reply here.`)).toBeNull();

		writeDraft(composer, `@${robin.handle} can you check?`);

		await screen.findByText(`${linear.name} won't reply.`);
	});

	it("offers no @here or @channel when nobody else could be notified", async () => {
		client.api.chats.get.mockReturnValue(
			Effect.succeed({
				...botChatDetails({ messages: [mainMessage] }),
				membersReachingProject: [member],
			}),
		);
		mount(chatPage);
		const composer = await screen.findByLabelText(`Message ${linear.name}`);
		writeDraft(composer, "@");

		const list = within(await screen.findByRole("listbox"));
		list.getByRole("option", { name: new RegExp(linear.name) });
		expect(list.queryByRole("option", { name: /@here|@channel/ })).toBeNull();
	});

	it("holds a message for a bot with no model, saying where to choose one, but sends one for members only", async () => {
		client.api.bots.list.mockReturnValue(
			Effect.succeed(bots.map((one) => (one.id === linear.id ? { ...one, model: null } : one))),
		);
		client.api.chats.send.mockReturnValue(
			Effect.succeed({ message: mainMessage, routing: { status: "routed" } }),
		);
		mount(chatPage);

		await screen.findByText(/has no model yet/);
		expect(screen.getByRole("link", { name: "Choose a model" }).getAttribute("href")).toBe(
			`/suga/bots/${linear.handle}/settings`,
		);
		const composer = screen.getByLabelText(`Message ${linear.name}`);
		writeDraft(composer, "Send the update");
		const send = screen.getByRole("button", { name: "Send message" }) as HTMLButtonElement;
		expect(send.disabled).toBe(true);
		expect(screen.queryByText(`${linear.name} will reply here.`)).toBeNull();

		// A message for members alone asks no bot to reply, so it goes.
		writeDraft(composer, `@${robin.handle} can you check?`);
		await waitFor(() => expect(screen.queryByText(/has no model yet/)).toBeNull());
		fireEvent.click(screen.getByRole("button", { name: "Send message" }));
		await waitFor(() => expect(client.api.chats.send).toHaveBeenCalled());
	});

	it("replaces the optimistic message when the server assigns its ID", async () => {
		const posting = pendingAnswer();
		client.api.chats.send.mockReturnValue(posting.effect);
		const updates = controlledEventStream();
		client.events.chat.mockReturnValue(updates.stream);
		const queries = createQueryClient();
		mount(chatPage, { queries });
		const composer = await screen.findByLabelText(`Message ${linear.name}`, undefined, {
			timeout: 10_000,
		});
		writeDraft(composer, "Send the update");
		fireEvent.click(screen.getByRole("button", { name: "Send message" }));

		await waitFor(() => expect(composer.textContent).toBe(""));
		await screen.findByText("Send the update");
		const [request] = client.api.chats.send.mock.calls[0] ?? [];
		const { retryKey } = (request as { payload: { retryKey: string } }).payload;
		const saved: Message = {
			...mainMessage,
			id: "0199a3a0-0000-7000-8000-0000000000fc",
			retryKey,
			content: "Send the update",
			parts: [{ type: "text", text: "Send the update" }],
		};
		updates.emit(streamEvent("message.created", { chatId: chat.id, message: saved }));
		await waitFor(() =>
			expect(queries.getQueryData<ChatDetails>(["chat", chat.id])?.messages).toContainEqual(saved),
		);
		expect(screen.getAllByText("Send the update")).toHaveLength(1);
		posting.answer(Effect.succeed(saved));
	});

	it("puts the draft back after a lost response and reuses the retry key", async () => {
		client.api.chats.messages.mockImplementation(() =>
			Effect.succeed({ items: [{ kind: "message", message: mainMessage }], nextCursor: null }),
		);
		client.api.chats.history.mockImplementation(() =>
			Effect.succeed({ items: [], nextCursor: null }),
		);
		client.api.chats.send.mockReturnValue(
			Effect.fail(new InternalServerError({ message: userText`Nope` })),
		);
		mount(chatPage);
		const composer = await screen.findByLabelText(`Message ${linear.name}`, undefined, {
			timeout: 10_000,
		});
		writeDraft(composer, "Send the update");
		fireEvent.click(screen.getByRole("button", { name: "Send message" }));

		await screen.findByText("Message not sent. Your draft is still here.");
		expect(composer.textContent).toBe("Send the update");
		fireEvent.click(screen.getByRole("button", { name: "Send message" }));
		await waitFor(() => expect(client.api.chats.send).toHaveBeenCalledTimes(2));
		const [first, retry] = client.api.chats.send.mock.calls.map(([request]) => request);
		expect(retry).toEqual(first);
	});

	it("keeps an unsent draft while you are elsewhere, with the cursor at its end", async () => {
		const { router } = mount(chatPage);
		writeDraft(await screen.findByLabelText(`Message ${linear.name}`), "Half a thought");

		const composer = await leaveAndReturn(router);
		expect(composer.textContent).toBe("Half a thought");
		composer.focus();
		expect(document.getSelection()?.focusOffset).toBe("Half a thought".length);
	});

	it("forgets the draft once it is sent", async () => {
		client.api.chats.send.mockReturnValue(
			Effect.succeed({ message: mainMessage, routing: { status: "routed" } }),
		);
		const { router } = mount(chatPage);
		writeDraft(await screen.findByLabelText(`Message ${linear.name}`), "Send the update");
		fireEvent.click(screen.getByRole("button", { name: "Send message" }));
		await waitFor(() => expect(client.api.chats.send).toHaveBeenCalled());

		const composer = await leaveAndReturn(router);
		expect(composer.textContent).toBe("");
	});

	it("fetches the chat again when its workspace's events start over", async () => {
		const updates = controlledEventStream();
		client.events.workspace.mockReturnValue(updates.stream);
		mount(chatPage);
		await screen.findByRole("log", { name: "Chat messages" });
		await waitFor(() => expect(client.events.workspace).toHaveBeenCalled());

		const missed = {
			...botMessage,
			id: "0199a3a0-0000-7000-8000-0000000000fe",
			content: "Sent while the stream was behind",
			parts: [{ type: "text" as const, text: "Sent while the stream was behind" }],
			createdAt: "2026-09-18T09:25:00.000Z",
		};
		client.api.chats.messages.mockReturnValue(
			Effect.succeed({
				items: [
					{ kind: "message", message: mainMessage },
					{ kind: "message", message: botMessage },
					{ kind: "message", message: missed },
				],
				nextCursor: null,
			}),
		);
		updates.emit(streamEvent("reset"));

		await screen.findByText("Sent while the stream was behind");
	});

	it("fetches the chat again when who reaches what changes, so whose turns its members may interrupt keeps up", async () => {
		const updates = controlledEventStream();
		client.events.workspace.mockReturnValue(updates.stream);
		mount(chatPage);
		await screen.findByRole("log", { name: "Chat messages" });
		await waitFor(() => expect(client.events.workspace).toHaveBeenCalled());
		const fetched = client.api.chats.get.mock.calls.length;

		updates.emit(
			streamEvent("reach.changed", { about: { kind: "membership", memberId: member.id } }),
		);

		await waitFor(() => expect(client.api.chats.get.mock.calls.length).toBeGreaterThan(fetched));
	});

	it("shows a file the bot attaches while it still answers, and keeps it as the answer goes on", async () => {
		const updates = controlledEventStream();
		client.events.chat.mockReturnValue(updates.stream);
		mount(chatPage);
		await screen.findByRole("log", { name: "Chat messages" });
		await waitFor(() => expect(client.events.chat).toHaveBeenCalledWith(chat.id));
		const writing = {
			...botMessage,
			id: "0199a3a0-0000-7000-8000-0000000000fc",
			status: "writing" as const,
			content: "Here it is",
			parts: [{ type: "text" as const, text: "Here it is" }],
			createdAt: "2026-09-18T09:20:00.000Z",
		};
		updates.emit(streamEvent("message.created", { chatId: chat.id, message: writing }));
		await screen.findByRole("status", { name: `${linear.name} is typing` });

		// Before the reply's words are settled enough to show, its file already is.
		updates.emit(
			streamEvent("message.files_changed", {
				chatId: chat.id,
				messageId: writing.id,
				files: [
					{
						type: "file",
						id: "0199a3a0-0000-7000-8000-0000000000fd",
						name: "q3-report.csv",
						contentType: "text/csv",
						size: 2_048,
					},
				],
			}),
		);
		await screen.findByRole("link", { name: "Download q3-report.csv" });

		updates.emit(
			streamEvent("message.delta", {
				chatId: chat.id,
				messageId: writing.id,
				offset: writing.content.length,
				text: ", with the totals.",
				execution: 1,
			}),
		);
		updates.emit(
			streamEvent("message.completed", {
				chatId: chat.id,
				messageId: writing.id,
				content: "Here it is, with the totals.",
				status: "complete",
				finishedAt: "2026-11-23T10:00:00.000Z",
			}),
		);
		await screen.findByText("Here it is, with the totals.");
		screen.getByRole("link", { name: "Download q3-report.csv" });
	});

	it("shows live thinking under the reply and drops deltas from a superseded execution", async () => {
		const updates = controlledEventStream();
		client.events.chat.mockReturnValue(updates.stream);
		mount(chatPage);
		await screen.findByRole("log", { name: "Chat messages" });
		await waitFor(() => expect(client.events.chat).toHaveBeenCalledWith(chat.id));
		const writing = {
			...botMessage,
			id: "0199a3a0-0000-7000-8000-0000000000fa",
			status: "writing" as const,
			content: "",
			parts: [],
		};
		updates.emit(streamEvent("message.created", { chatId: chat.id, message: writing }));
		const reply = { chatId: chat.id, messageId: writing.id };
		const think = (execution: number, offset: number, text: string) =>
			updates.emit(
				streamEvent("message.thinking_delta", { ...reply, execution, step: 1, offset, text }),
			);

		think(1, 0, "Still checking.");
		const disclosure = await screen.findByRole("button", { name: "Thinking", expanded: false });
		fireEvent.click(disclosure);
		await screen.findByText("Still checking.");

		updates.emit(
			streamEvent("message.execution_started", {
				...reply,
				execution: 2,
				content: "",
				thinking: [{ step: 0, text: "Read the chat." }],
			}),
		);
		think(1, "Still checking.".length, " Stale.");
		think(2, 0, "Verified.");
		think(2, 0, "Verified.");
		updates.emit(
			streamEvent("message.delta", { ...reply, execution: 2, offset: 0, text: "Done." }),
		);

		await screen.findByText("Done.");
		screen.getByText("Read the chat.");
		screen.getByText("Verified.");
		expect(screen.queryByText(/Still checking|Stale/)).toBeNull();
	});

	it("keeps thinking its execution already wrote when that execution's start arrives after the fetch", async () => {
		const updates = controlledEventStream();
		client.events.chat.mockReturnValue(updates.stream);
		const writing: Message = {
			...botMessage,
			status: "writing",
			thinking: [{ step: 0, text: "Looked at the current record." }],
			execution: 1,
		};
		client.api.chats.get.mockReturnValue(
			Effect.succeed(botChatDetails({ messages: [mainMessage, writing] })),
		);
		mount(chatPage);
		await screen.findByText(writing.content);
		await waitFor(() => expect(client.events.chat).toHaveBeenCalledWith(chat.id));

		updates.emit(
			streamEvent("message.execution_started", {
				chatId: chat.id,
				messageId: writing.id,
				execution: 1,
				content: "",
			}),
		);
		updates.emit(streamEvent("chat.notice", { chatId: chat.id, notice: "Execution started." }));

		await screen.findByText("Execution started.");
		fireEvent.click(screen.getByRole("button", { name: "Thinking" }));
		await screen.findByText("Looked at the current record.");
	});

	it.each([true, false])(
		"reconciles a finished or silent turn on refetch (answered %s)",
		async (answered) => {
			const updates = controlledEventStream();
			client.events.chat.mockReturnValue(updates.stream);
			const writing: Message = {
				...botMessage,
				id: "0199a3a0-0000-7000-8000-0000000000f8",
				status: "writing",
				content: "Draft reply.",
				parts: [{ type: "text", text: "Draft reply." }],
				thinking: [{ step: 0, text: "Check it once more." }],
			};
			client.api.chats.get.mockReturnValue(
				Effect.succeed(botChatDetails({ messages: [mainMessage, writing] })),
			);
			mount(chatPage);
			await screen.findByText(writing.content);
			await waitFor(() => expect(client.events.chat).toHaveBeenCalledWith(chat.id));

			if (answered) {
				updates.emit(
					streamEvent("message.completed", {
						chatId: chat.id,
						messageId: writing.id,
						content: "Final reply.",
						status: "complete",
						finishedAt: "2026-11-23T10:00:00.000Z",
					}),
				);
				await screen.findByText("Final reply.");
			}
			const marker: Message = {
				...mainMessage,
				content: "The fresh chat page has arrived.",
				parts: [{ type: "text", text: "The fresh chat page has arrived." }],
			};
			client.api.chats.get.mockReturnValue(
				Effect.succeed(botChatDetails({ messages: answered ? [marker, writing] : [marker] })),
			);
			updates.emit(streamEvent("turn.completed", { chatId: chat.id }));
			await screen.findByText(marker.content);

			expect(screen.queryByText(writing.content)).toBeNull();
			if (answered) {
				screen.getByText("Final reply.");
			} else {
				expect(screen.queryByText("Thinking")).toBeNull();
			}
		},
	);

	it("shows the newest execution's words when a turn resumed elsewhere writes its step again", async () => {
		const updates = controlledEventStream();
		client.events.chat.mockReturnValue(updates.stream);
		mount(chatPage);
		await screen.findByRole("log", { name: "Chat messages" });
		await waitFor(() => expect(client.events.chat).toHaveBeenCalledWith(chat.id));
		const writing = {
			...botMessage,
			id: "0199a3a0-0000-7000-8000-0000000000fe",
			status: "writing" as const,
			content: "",
			parts: [],
			createdAt: "2026-09-18T09:20:00.000Z",
		};
		updates.emit(streamEvent("message.created", { chatId: chat.id, message: writing }));
		const delta = (execution: number, offset: number, text: string) =>
			updates.emit(
				streamEvent("message.delta", {
					chatId: chat.id,
					messageId: writing.id,
					offset,
					text,
					execution,
				}),
			);
		delta(1, 0, "The old process wrote this");
		await screen.findByText("The old process wrote this");

		// The turn resumed elsewhere, which writes the step again; the old
		// process's late words are dropped.
		updates.emit(
			streamEvent("message.execution_started", {
				chatId: chat.id,
				messageId: writing.id,
				execution: 2,
				content: "",
			}),
		);
		delta(2, 0, "The resumed turn wrote this");
		delta(1, 26, " and then this");

		await screen.findByText("The resumed turn wrote this");
		expect(screen.queryByText(/and then this/)).toBeNull();

		const recovered = "The resumed turn";
		updates.emit(
			streamEvent("message.execution_started", {
				chatId: chat.id,
				messageId: writing.id,
				execution: 3,
				content: recovered,
			}),
		);
		delta(2, recovered.length, " Stale text while writing.");
		updates.emit(streamEvent("chat.notice", { chatId: chat.id, notice: "Execution resumed." }));

		await screen.findByText("Execution resumed.");
		screen.getByText(recovered);
		expect(screen.queryByText(/Stale text while writing/)).toBeNull();

		updates.emit(
			streamEvent("message.completed", {
				chatId: chat.id,
				messageId: writing.id,
				content: recovered,
				status: "complete",
				finishedAt: "2026-11-23T10:00:00.000Z",
			}),
		);
		delta(2, recovered.length, " Stale text after completion.");
		updates.emit(streamEvent("chat.notice", { chatId: chat.id, notice: "Execution ended." }));

		await screen.findByText("Execution ended.");
		screen.getByText(recovered);
		expect(screen.queryByText(/Stale text after completion/)).toBeNull();
	});

	it("keeps the fetched reply when its execution's start arrives with only its checkpoint text", async () => {
		const updates = controlledEventStream();
		client.events.chat.mockReturnValue(updates.stream);
		const content = "The report is ready to download.";
		const writing: Message = {
			...botMessage,
			id: crypto.randomUUID(),
			status: "writing",
			content,
			parts: [{ type: "text", text: content }],
			execution: 2,
		};
		answerChatWith(() => Effect.succeed(botChatDetails({ messages: [mainMessage, writing] })));
		mount(chatPage);
		await screen.findByText(content);

		updates.emit(
			streamEvent("message.execution_started", {
				chatId: chat.id,
				messageId: writing.id,
				execution: 2,
				content: "The report",
			}),
		);
		updates.emit(streamEvent("chat.notice", { chatId: chat.id, notice: "Execution resumed." }));

		await screen.findByText("Execution resumed.");
		screen.getByText(content);
	});

	it("shows the reply that finished while you were elsewhere", async () => {
		const writing: Message = {
			...botMessage,
			id: "0199a3a0-0000-7000-8000-0000000000fb",
			status: "writing",
			content: "",
			parts: [],
			createdAt: "2026-09-18T09:20:00.000Z",
		};
		const answered: Message = {
			...writing,
			status: "complete",
			content: "Checkout timeouts are tracked.",
			parts: [{ type: "text", text: "Checkout timeouts are tracked." }],
		};
		const chatWithReply = (reply: Message) =>
			Effect.succeed(botChatDetails({ messages: [mainMessage, reply] }));
		answerChatWith(() => chatWithReply(writing));
		const { router } = mount(chatPage);
		await screen.findByRole("status", { name: `${linear.name} is typing` });

		answerChatWith(() => chatWithReply(answered));
		await leaveAndReturn(router);

		await screen.findByText("Checkout timeouts are tracked.");
		expect(screen.queryByRole("status", { name: `${linear.name} is typing` })).toBeNull();
	});

	describe("reading the chat", () => {
		function windowFocused(focused: boolean) {
			const hasFocus = vi.spyOn(document, "hasFocus").mockReturnValue(focused);
			onTestFinished(() => hasFocus.mockRestore());
			return hasFocus;
		}

		it("leaves the chat unread while another window has focus, and reads it on coming back", async () => {
			const hasFocus = windowFocused(false);
			mount(chatPage);
			await screen.findByText(mainMessage.content);
			expect(client.api.chats.markRead).not.toHaveBeenCalled();

			hasFocus.mockReturnValue(true);
			fireEvent.focus(window);

			await waitFor(() =>
				expect(client.api.chats.markRead).toHaveBeenCalledWith({
					params: { chatId: chat.id },
				}),
			);
		});

		it("leaves a reply unread while scrolled back through the chat, and reads it at the latest message", async () => {
			windowFocused(true);
			const updates = controlledEventStream();
			client.events.chat.mockReturnValue(updates.stream);
			mount(chatPage);
			const messages = await findMessagesViewport();
			await waitFor(() => expect(client.api.chats.markRead).toHaveBeenCalled());
			Object.defineProperties(messages, {
				scrollHeight: { configurable: true, value: 1_200 },
				clientHeight: { configurable: true, value: 400 },
			});
			messages.scrollTop = 200;
			fireEvent.scroll(messages);
			client.api.chats.markRead.mockClear();

			updates.emit(
				streamEvent("message.created", {
					chatId: chat.id,
					message: {
						...botMessage,
						id: "0199a3a0-0000-7000-8000-000000000120",
						content: "The deploy finished.",
						parts: [{ type: "text", text: "The deploy finished." }],
						createdAt: "2026-09-18T09:20:00.000Z",
					},
				}),
			);
			await screen.findByText("The deploy finished.");
			expect(client.api.chats.markRead).not.toHaveBeenCalled();

			messages.scrollTop = 800;
			fireEvent.scroll(messages);

			await waitFor(() => expect(client.api.chats.markRead).toHaveBeenCalledOnce());
		});
	});

	describe("messages waiting for the next reply", () => {
		const writing: Message = {
			...botMessage,
			id: "0199a3a0-0000-7000-8000-0000000000fc",
			status: "writing",
			content: "",
			parts: [],
			createdAt: "2026-09-18T09:20:00.000Z",
		};
		const followUp: Message = {
			...mainMessage,
			id: "0199a3a0-0000-7000-8000-0000000000fd",
			author: testMember({ id: "0199a3a0-0000-7000-8000-0000000000fe", name: "Jay Park" }),
			content: "Is the Stripe webhook part of it?",
			parts: [{ type: "text", text: "Is the Stripe webhook part of it?" }],
			createdAt: "2026-09-18T09:21:00.000Z",
		};
		/** The chat as the server has it, with `queuedSince` when a turn started waiting. */
		const serverHas = (queuedSince: string | null) =>
			client.api.chats.get.mockReturnValue(
				Effect.succeed({
					...botChatDetails({ messages: [mainMessage, writing, followUp] }),
					queuedSince,
				}),
			);

		async function watchWhileReplying() {
			const updates = controlledEventStream();
			client.events.chat.mockReturnValue(updates.stream);
			serverHas(null);
			mount(chatPage);
			await screen.findByRole("log", { name: "Chat messages" });
			await waitFor(() => expect(client.events.chat).toHaveBeenCalledWith(chat.id));
			updates.emit(streamEvent("message.created", { chatId: chat.id, message: writing }));
			updates.emit(streamEvent("message.created", { chatId: chat.id, message: followUp }));
			await screen.findByText("Is the Stripe webhook part of it?");
			return updates;
		}

		it("says a message waits for the next reply, until that reply starts", async () => {
			const updates = await watchWhileReplying();

			serverHas(followUp.createdAt);
			updates.emit(streamEvent("chat.changed", { chatId: chat.id }));
			await screen.findByRole("article", { name: "Jay Park, queued" });

			serverHas(null);
			updates.emit(streamEvent("turn.started", { chatId: chat.id }));
			await waitFor(() =>
				expect(screen.queryByRole("article", { name: "Jay Park, queued" })).toBeNull(),
			);
		});

		it("does not say a message waits when the server queued no reply for it", async () => {
			await watchWhileReplying();

			expect(screen.queryByRole("article", { name: "Jay Park, queued" })).toBeNull();
		});
	});

	it("opens with whom the chat is with, when there is nothing older", async () => {
		client.api.chats.messages.mockReturnValue(Effect.succeed({ items: [], nextCursor: null }));
		client.api.chats.get.mockReturnValue(Effect.succeed(botChatDetails({ messages: [] })));
		mount(chatPage);

		await screen.findByRole("heading", { name: "Chat", level: 2 });
		screen.getByText(`With ${linear.name}`);
	});

	it("opens Details from the chat's name, and leads back to its bot", async () => {
		mount(chatPage);

		const name = await screen.findByRole("button", { name: "Chat" });
		expect(screen.getByRole("link", { name: `Back to ${linear.name}` }).getAttribute("href")).toBe(
			`/suga/bots/${linear.handle}`,
		);
		fireEvent.click(name);

		await screen.findByRole("complementary", { name: "Details" });
	});

	it("keeps Details closed when the chat is opened again, once they were closed where they sit beside it", async () => {
		vi.stubGlobal("matchMedia", (query: string) => ({
			matches: true,
			media: query,
			onchange: null,
			addEventListener: () => {},
			removeEventListener: () => {},
			addListener: () => {},
			removeListener: () => {},
			dispatchEvent: () => false,
		}));
		onTestFinished(() => {
			vi.unstubAllGlobals();
		});
		const { router } = mount(chatPage);

		await screen.findByRole("complementary", { name: "Details" });
		fireEvent.click(screen.getByRole("button", { name: "Details", pressed: true }));
		await waitFor(() =>
			expect(screen.queryByRole("complementary", { name: "Details" })).toBeNull(),
		);
		await leaveAndReturn(router);

		screen.getByRole("button", { name: "Details", pressed: false });
		expect(screen.queryByRole("complementary", { name: "Details" })).toBeNull();
	});

	/** A phone's Back at the head of a bot's own page, which returns to the page it was opened from. */
	async function backFromBotPage() {
		const header = (await screen.findByRole("heading", { name: "Settings", level: 1 })).closest(
			"header",
		);
		if (!header) throw new Error("No page header");
		return within(header).getByRole("link", { name: "Back" });
	}

	it("leads from its bot's settings back to the chat they were opened from", async () => {
		const { router } = mount(chatPage);
		fireEvent.click(await screen.findByRole("button", { name: "Details" }));
		const details = await screen.findByRole("complementary", { name: "Details" });

		fireEvent.click(within(details).getByRole("link", { name: "Settings" }));
		await screen.findByRole("heading", { name: linear.name });
		fireEvent.click(await backFromBotPage());

		await waitFor(() => expect(router.state.location.pathname).toBe(chatPage));
	});

	it("leads from a member's name to their page over the chat, and back to it", async () => {
		answerMessagesWith({
			...mainMessage,
			id: "0199a3a0-0000-7000-8000-0000000000fa",
			author: testMember({ id: juno.id, name: juno.name }),
			createdAt: "2026-09-18T09:15:00.000Z",
		});
		const { router } = mount(chatPage);
		const messages = await screen.findByRole("log", { name: "Chat messages" });

		fireEvent.click(await within(messages).findByRole("link", { name: juno.name }));
		await screen.findByRole("heading", { name: juno.name });
		expect(settingsOpenIn(router)).toBe("members/0199a3a0-0000-7000-8000-0000000000d2");
		// The bar's Back and the page's own, which style hides one of, both go back.
		const [back] = await within(await screen.findByRole("main")).findAllByRole("link", {
			name: "Back",
		});
		fireEvent.click(back as HTMLElement);

		await waitFor(() => expect(router.state.location.href).toBe(chatPage));
	});

	it("leads from a bot's name to its settings, and back to the chat", async () => {
		answerMessagesWith({
			...mainMessage,
			id: "0199a3a0-0000-7000-8000-0000000000fa",
			author: pastParticipant,
			createdAt: "2026-09-18T09:15:00.000Z",
		});
		const { router } = mount(chatPage);
		const messages = await screen.findByRole("log", { name: "Chat messages" });

		fireEvent.click(
			(await within(messages).findAllByRole("link", { name: triager.name }))[0] as HTMLElement,
		);
		await screen.findByRole("heading", { name: triager.name });
		expect(router.state.location.pathname).toBe(`/suga/bots/${triager.handle}/settings`);
		fireEvent.click(await backFromBotPage());

		await waitFor(() => expect(router.state.location.pathname).toBe(chatPage));
	});

	it("lists the members taking part in a chat with more than one from its header, the viewer as you", async () => {
		const shared = botChatDetails({ messages: [mainMessage] });
		client.api.chats.get.mockReturnValue(
			Effect.succeed({ ...shared, participants: [...shared.participants, robin] }),
		);
		mount(chatPage);

		fireEvent.click(
			await screen.findByRole("button", { name: "2 members taking part in this chat" }),
		);

		const members = await screen.findByRole("menu");
		const [first, second, ...rest] = within(members).getAllByRole("menuitem");
		expect(first?.textContent).toContain("(you)");
		expect(second?.textContent).toContain(robin.name);
		expect(rest).toEqual([]);
	});

	it("opens a chat the bot started with a bot outside its project at that bot's address", async () => {
		const startedId = "0199a3a0-0000-7000-8000-0000000002a1";
		const startedChat = botChatDetails({ chat: { id: startedId, title: "Release checklist" } });
		answerMessagesWith({
			...botMessage,
			id: "0199a3a0-0000-7000-8000-0000000002a2",
			parts: [
				{ type: "text", text: "I've asked Triager." },
				{
					type: "tool_call",
					id: "0199a3a0-0000-7000-8000-0000000002a3",
					tool: START_CHAT_TOOL,
					input: {},
					output: {
						chat: {
							id: startedId,
							title: "Release checklist",
							with: triager.name,
							withBotId: triager.id,
						},
					},
					status: "completed",
					error: null,
					approval: null,
					atOffset: 0,
					startedAt: "2026-09-18T09:16:00.000Z",
					finishedAt: "2026-09-18T09:16:01.000Z",
				},
			],
			content: "I've asked Triager.",
			createdAt: "2026-09-18T09:16:00.000Z",
		});
		const usual = client.api.chats.get.getMockImplementation();
		client.api.chats.get.mockImplementation((request: { params: { chatId: string } }) =>
			request.params.chatId === startedId
				? Effect.succeed({
						...startedChat,
						chat: { ...startedChat.chat, botId: triager.id },
					})
				: usual?.(request),
		);
		const { router } = mount(chatPage);

		fireEvent.click(await screen.findByRole("link", { name: "Open chat: Release checklist" }));

		await waitFor(() =>
			expect(router.state.location.pathname).toBe(
				`/suga/bots/${triager.handle}/chats/${startedId}`,
			),
		);
	});
});

describe("a message or nested chat a notification opens", () => {
	const older: Message = {
		...mainMessage,
		id: "0199a3a0-0000-7000-8000-000000000201",
		parts: [{ type: "text", text: "Can you look at the release?" }],
		content: "Can you look at the release?",
		createdAt: "2026-09-17T09:00:00.000Z",
	};
	const opened = (messageId: string) => `/suga/chats/${chat.id}?message=${messageId}`;

	beforeEach(() => {
		client.api.chats.messages.mockImplementation(({ query }: { query?: { cursor?: string } }) =>
			Effect.succeed(
				query?.cursor
					? { items: [{ kind: "message", message: older }], nextCursor: null }
					: {
							items: [
								{ kind: "message", message: mainMessage },
								{ kind: "message", message: botMessage },
							],
							nextCursor: "older-page",
						},
			),
		);
	});

	it("loads older messages until it reaches the message, and moves the focus to it", async () => {
		mount(opened(older.id));

		const row = (await screen.findByText(older.content)).closest("[data-message-id]");
		await waitFor(() => expect(document.activeElement).toBe(row));
		expect(client.api.chats.messages).toHaveBeenCalledWith(
			expect.objectContaining({ query: expect.objectContaining({ cursor: "older-page" }) }),
		);
	});

	it("shows the run a notification names as the page, at the chat's own address", async () => {
		mount(`${chatPage}?nestedChatPage=${automationId}`);

		await screen.findByRole("heading", { name: automationRun.automationName });
		expect(screen.queryByRole("log", { name: "Chat messages" })).toBeNull();
		screen.getByRole("link", { name: `Back to ${linear.name}` });
		expect(screen.getByRole("link", { name: "Open chat" }).getAttribute("href")).toBe(chatPage);
	});

	it("says so when the message cannot be found in the chat", async () => {
		mount(opened("0199a3a0-0000-7000-8000-000000000299"));

		await screen.findByText("Could not find the message you opened in this chat.");
	});

	it("opens a run's automation on its bot's automations page, where it is changed, from the run's header", async () => {
		mount(`${chatPage}?nestedChatPage=${automationId}`);

		const settings = await screen.findByRole("link", { name: "Automation settings" });
		expect(settings.getAttribute("href")).toBe(
			`/suga/bots/${linear.handle}/automations/${automationRun.automationId}`,
		);
	});

	it("reads the automation run opened as a page once the window has focus, and not the rest of its chat", async () => {
		const hasFocus = vi.spyOn(document, "hasFocus").mockReturnValue(false);
		onTestFinished(() => hasFocus.mockRestore());
		mount(`${chatPage}?nestedChatPage=${automationId}`);
		await screen.findByRole("heading", { name: automationRun.automationName });
		expect(client.api.chats.markNestedChatRead).not.toHaveBeenCalled();

		hasFocus.mockReturnValue(true);
		fireEvent.focus(window);

		await waitFor(() =>
			expect(client.api.chats.markNestedChatRead).toHaveBeenCalledWith({
				params: { chatId: automationId },
			}),
		);
		expect(client.api.chats.markRead).not.toHaveBeenCalled();
	});

	it("ignores an address naming something other than a message", async () => {
		mount(`/suga/chats/${chat.id}?message=a%22b`);

		await screen.findByText(mainMessage.content);
		expect(screen.queryByText("Could not find the message you opened in this chat.")).toBeNull();
	});
});

describe("members typing in the chat", () => {
	const junoInChat = testMember({ id: juno.id, name: juno.name });
	const junoTyping = streamEvent("member.typing", {
		chatId: chat.id,
		member: junoInChat,
	});

	async function watchChat() {
		const updates = controlledEventStream();
		client.events.chat.mockReturnValue(updates.stream);
		mount(chatPage);
		await waitFor(() => expect(client.events.chat).toHaveBeenCalledWith(chat.id));
		return updates;
	}

	afterEach(() => {
		vi.useRealTimers();
	});

	it("shows someone else typing until their message arrives", async () => {
		const updates = await watchChat();

		updates.emit(junoTyping);
		await screen.findByRole("status", { name: "Juno is typing" });

		updates.emit(
			streamEvent("message.created", {
				chatId: chat.id,
				message: {
					...mainMessage,
					id: "0199a3a0-0000-7000-8000-0000000000fc",
					author: junoInChat,
					content: "Also, the deploy",
					parts: [{ type: "text", text: "Also, the deploy" }],
					createdAt: "2026-09-18T09:40:00.000Z",
				},
			}),
		);
		await screen.findByText("Also, the deploy");
		expect(screen.queryByRole("status", { name: "Juno is typing" })).toBeNull();
	});

	it("stops showing someone typing once they stop saying so", async () => {
		vi.useFakeTimers({ shouldAdvanceTime: true });
		const updates = await watchChat();

		updates.emit(junoTyping);
		await screen.findByRole("status", { name: "Juno is typing" });

		await vi.advanceTimersByTimeAsync(TYPING_SHOWN_FOR_MS);
		await waitFor(() =>
			expect(screen.queryByRole("status", { name: "Juno is typing" })).toBeNull(),
		);
	});

	it("does not show you your own typing", async () => {
		const updates = await watchChat();

		updates.emit(streamEvent("member.typing", { chatId: chat.id, member }));
		updates.emit(junoTyping);

		await screen.findByRole("status", { name: "Juno is typing" });
		expect(screen.queryByRole("status", { name: /Sam/ })).toBeNull();
	});

	it("does not say you are typing just because a draft was kept from before", async () => {
		const { router } = mount(chatPage);
		writeDraft(await screen.findByLabelText(`Message ${linear.name}`), "Half a thought");
		await waitFor(() => expect(client.api.events.reportTyping).toHaveBeenCalledTimes(1));
		client.api.events.reportTyping.mockClear();
		client.events.chat.mockClear();

		await leaveAndReturn(router);
		await waitFor(() => expect(client.events.chat).toHaveBeenCalledWith(chat.id));
		expect(client.api.events.reportTyping).not.toHaveBeenCalled();
	});

	it("tells the chat you are typing, once for a burst of keystrokes", async () => {
		mount(chatPage);
		const composer = await screen.findByLabelText(`Message ${linear.name}`);

		writeDraft(composer, "S");
		writeDraft(composer, "Se");
		writeDraft(composer, "Sen");

		await waitFor(() =>
			expect(client.api.events.reportTyping).toHaveBeenCalledWith({
				params: { chatId: chat.id },
			}),
		);
		expect(client.api.events.reportTyping).toHaveBeenCalledTimes(1);
	});
});

describe("the chat's stream", () => {
	/** A reply of Linear Handler's still being written by `execution`, saying `content`. */
	const writingReply = (content: string, execution?: number): Message => ({
		...botMessage,
		id: "0199a3a0-0000-7000-8000-000000000301",
		status: "writing",
		content,
		parts: content ? [{ type: "text", text: content }] : [],
		createdAt: "2026-09-18T09:20:00.000Z",
		...(execution === undefined ? {} : { execution }),
	});

	/** Opens the chat on a stream the case scripts, once the chat has been fetched and is followed. */
	async function openChat() {
		const updates = controlledEventStream();
		client.events.chat.mockReturnValue(updates.stream);
		const opened = mount(chatPage, { refresh: vi.fn(async () => {}) });
		await screen.findByText(mainMessage.content);
		await waitFor(() => expect(client.events.chat).toHaveBeenCalledWith(chat.id));
		return { updates, ...opened };
	}

	it("shows what changed between the first fetch and the stream starting, and what follows it", async () => {
		const { updates } = await openChat();
		const madeMeanwhile: Message = {
			...botMessage,
			content: "Finished while the stream started.",
			parts: [{ type: "text", text: "Finished while the stream started." }],
		};
		const afterReady: Message = {
			...mainMessage,
			id: "0199a3a0-0000-7000-8000-000000000302",
			content: "And one after it.",
			parts: [{ type: "text", text: "And one after it." }],
			createdAt: "2026-09-18T09:40:00.000Z",
		};
		const refetched = pendingAnswer();
		answerChatWith(() => refetched.effect as ReturnType<typeof client.api.chats.get>);

		updates.emit(streamEvent("ready"));
		updates.emit(streamEvent("message.created", { chatId: chat.id, message: afterReady }));
		await waitFor(() => expect(client.api.chats.get).toHaveBeenCalledTimes(2));
		refetched.answer(Effect.succeed(botChatDetails({ messages: [mainMessage, madeMeanwhile] })));

		await screen.findByText("Finished while the stream started.");
		await screen.findByText("And one after it.");
	});

	it("shows the chat as fetched after a reset, not what it held before", async () => {
		const failed: Message = {
			...writingReply("Partial answer"),
			status: "failed",
			error: "The model provider could not answer.",
		};
		answerChatWith(() => Effect.succeed(botChatDetails({ messages: [mainMessage, failed] })));
		const { updates } = await openChat();
		await screen.findByText("Partial answer");

		// The turn ran again while the stream was away, starting its reply over.
		answerChatWith(() =>
			Effect.succeed(botChatDetails({ messages: [mainMessage, writingReply("Trying again", 1)] })),
		);
		updates.emit(streamEvent("reset"));

		await screen.findByText("Trying again");
		expect(screen.queryByText("Partial answer")).toBeNull();
	});

	/** The reply as its first run left it, failed, which its turn runs again. */
	const failedReply = (): Message => ({
		...writingReply("Partial answer", 1),
		status: "failed",
		error: "The model provider could not answer.",
	});

	it("writes a reply its turn runs again over the failed one, as the retry's events arrive", async () => {
		answerChatWith(() =>
			Effect.succeed(botChatDetails({ messages: [mainMessage, failedReply()] })),
		);
		const { updates } = await openChat();
		await screen.findByText("Partial answer");

		// Reopened, and not yet begun its first step: written by no execution yet.
		answerChatWith(() =>
			Effect.succeed(botChatDetails({ messages: [mainMessage, writingReply("")] })),
		);
		updates.emit(streamEvent("turn.started", { chatId: chat.id }));
		updates.emit(streamEvent("message.created", { chatId: chat.id, message: writingReply("") }));
		const reply = { chatId: chat.id, messageId: writingReply("").id };
		updates.emit(streamEvent("message.execution_started", { ...reply, execution: 2, content: "" }));
		updates.emit(
			streamEvent("message.delta", { ...reply, execution: 2, offset: 0, text: "Trying again" }),
		);

		await screen.findByText("Trying again");
		expect(screen.queryByText("Partial answer")).toBeNull();
		expect(screen.queryByText(/could not answer/)).toBeNull();
	});

	it("ignores a failure of an execution older than the one writing the reply", async () => {
		answerChatWith(() =>
			Effect.succeed(botChatDetails({ messages: [mainMessage, writingReply("Trying again", 2)] })),
		);
		const { updates } = await openChat();
		await screen.findByText("Trying again");
		const reply = { chatId: chat.id, messageId: writingReply("").id };
		const fetched = client.api.chats.get.mock.calls.length;

		updates.emit(
			streamEvent("message.failed", {
				...reply,
				execution: 1,
				error: "The model provider could not answer.",
			}),
		);
		updates.emit(
			streamEvent("message.delta", {
				...reply,
				execution: 2,
				offset: "Trying again".length,
				text: ", with the logs.",
			}),
		);

		await screen.findByText("Trying again, with the logs.");
		expect(screen.queryByText(/could not answer/)).toBeNull();
		// Taken as it came, with nothing to fetch again.
		expect(client.api.chats.get.mock.calls.length).toBe(fetched);
	});

	it("takes a newer execution's fetched reply over the failed one", async () => {
		answerChatWith(() =>
			Effect.succeed(botChatDetails({ messages: [mainMessage, failedReply()] })),
		);
		const { updates } = await openChat();
		await screen.findByText("Partial answer");

		answerChatWith(() =>
			Effect.succeed(botChatDetails({ messages: [mainMessage, writingReply("Trying again", 2)] })),
		);
		updates.emit(streamEvent("chat.changed", { chatId: chat.id }));

		await screen.findByText("Trying again");
		expect(screen.queryByText(/could not answer/)).toBeNull();
	});

	it("takes a newer execution's fetched text over an older one's longer streamed text", async () => {
		answerChatWith(() =>
			Effect.succeed(
				botChatDetails({
					messages: [mainMessage, writingReply("The plan has three steps", 1)],
				}),
			),
		);
		const { updates } = await openChat();
		await screen.findByText("The plan has three steps");

		answerChatWith(() =>
			Effect.succeed(botChatDetails({ messages: [mainMessage, writingReply("The plan", 2)] })),
		);
		updates.emit(streamEvent("chat.changed", { chatId: chat.id }));

		await screen.findByText("The plan");
		expect(screen.queryByText(/three steps/)).toBeNull();
	});

	it("adds a newer execution's words to its own text, not to what an older one wrote", async () => {
		answerChatWith(() =>
			Effect.succeed(botChatDetails({ messages: [mainMessage, writingReply("Looking at it", 1)] })),
		);
		const { updates } = await openChat();
		await screen.findByText("Looking at it");

		answerChatWith(() =>
			Effect.succeed(botChatDetails({ messages: [mainMessage, writingReply("Looking again", 2)] })),
		);
		updates.emit(
			streamEvent("message.delta", {
				chatId: chat.id,
				messageId: writingReply("").id,
				offset: "Looking at it".length,
				text: " now.",
				execution: 2,
			}),
		);

		await screen.findByText("Looking again now.");
		expect(screen.queryByText(/Looking at it/)).toBeNull();
	});

	it("keeps a newer execution's delta that overtook its start until the text it follows is fetched", async () => {
		answerChatWith(() =>
			Effect.succeed(botChatDetails({ messages: [mainMessage, writingReply("Old text", 1)] })),
		);
		const { updates } = await openChat();
		await screen.findByText("Old text");
		const reply = { chatId: chat.id, messageId: writingReply("").id };

		// Fetched just before this delta's own text was saved.
		answerChatWith(() =>
			Effect.succeed(botChatDetails({ messages: [mainMessage, writingReply("Hello", 2)] })),
		);
		updates.emit(
			streamEvent("message.delta", { ...reply, execution: 2, offset: 5, text: " world" }),
		);
		updates.emit(streamEvent("message.execution_started", { ...reply, execution: 2, content: "" }));
		updates.emit(streamEvent("chat.notice", { chatId: chat.id, notice: "All arrived." }));

		await screen.findByText("All arrived.");
		screen.getByText("Hello world");
	});

	it("keeps thinking that overtook its reply's creation until the reply arrives", async () => {
		const { updates } = await openChat();
		const reply = { chatId: chat.id, messageId: writingReply("").id };

		updates.emit(
			streamEvent("message.thinking_delta", {
				...reply,
				execution: 1,
				step: 1,
				offset: 0,
				text: "Reading the chat.",
			}),
		);
		updates.emit(streamEvent("message.created", { chatId: chat.id, message: writingReply("") }));

		fireEvent.click(await screen.findByRole("button", { name: "Thinking" }));
		await screen.findByText("Reading the chat.");
	});

	it("keeps one turn's early thinking when another turn ends and the chat can't be fetched", async () => {
		const { updates } = await openChat();
		const usualChat = client.api.chats.get.getMockImplementation();
		const refetched = vi.fn();
		// A refusal is not retried, so the refetch fails at once.
		answerChatWith(() => {
			refetched();
			return Effect.fail(new NotFound({ message: userText`No such chat` }));
		});

		updates.emit(
			streamEvent("message.thinking_delta", {
				chatId: chat.id,
				messageId: writingReply("").id,
				execution: 1,
				step: 1,
				offset: 0,
				text: "Reading the chat.",
			}),
		);
		updates.emit(streamEvent("turn.completed", { chatId: chat.id }));
		await waitFor(() => expect(refetched).toHaveBeenCalled());
		if (usualChat) client.api.chats.get.mockImplementation(usualChat);
		updates.emit(streamEvent("message.created", { chatId: chat.id, message: writingReply("") }));

		fireEvent.click(await screen.findByRole("button", { name: "Thinking" }));
		await screen.findByText("Reading the chat.");
	});

	it("keeps a reply fetched when its turn started over the empty one its creation carries", async () => {
		const { updates } = await openChat();
		answerChatWith(() =>
			Effect.succeed(botChatDetails({ messages: [mainMessage, writingReply("Already on it", 1)] })),
		);

		updates.emit(streamEvent("turn.started", { chatId: chat.id }));
		updates.emit(streamEvent("message.created", { chatId: chat.id, message: writingReply("") }));
		updates.emit(streamEvent("chat.notice", { chatId: chat.id, notice: "Both arrived." }));

		await screen.findByText("Both arrived.");
		screen.getByText("Already on it");
	});

	it("fetches the chat's pages again on a reset, dropping a reply removed while the stream was away", async () => {
		const draft = writingReply("Draft reply.", 1);
		answerMessagesWith(draft);
		answerChatWith(() => Effect.succeed(botChatDetails({ messages: [mainMessage, draft] })));
		const { updates } = await openChat();
		await screen.findByText("Draft reply.");

		// The turn stayed silent while the stream was away, removing its reply.
		chatAnswers();
		updates.emit(streamEvent("reset"));

		await waitFor(() => expect(screen.queryByText("Draft reply.")).toBeNull());
		screen.getByText(botMessage.content);
	});

	it("takes a reply its silent turn removed out of the chat's pages too", async () => {
		const draft = writingReply("Draft reply.", 1);
		answerMessagesWith(draft);
		answerChatWith(() => Effect.succeed(botChatDetails({ messages: [mainMessage, draft] })));
		const { updates } = await openChat();
		await screen.findByText("Draft reply.");

		answerChatWith(() => Effect.succeed(botChatDetails({ messages: [mainMessage, botMessage] })));
		updates.emit(streamEvent("turn.completed", { chatId: chat.id }));

		await waitFor(() => expect(screen.queryByText("Draft reply.")).toBeNull());
		screen.getByText(botMessage.content);
	});

	/** Opens the chat on a stream the server ends for good with `refuse`, once the chat is shown. */
	async function openChatToBeRefused() {
		const { promise: refusal, reject: refuse } = Promise.withResolvers<never>();
		client.events.chat.mockReturnValue({
			// biome-ignore lint/correctness/useYield: a stream the server refuses yields nothing.
			async *[Symbol.asyncIterator]() {
				await refusal;
			},
			close: vi.fn(),
		});
		const refresh = vi.fn(async () => {});
		mount(chatPage, { refresh });
		await screen.findByText(mainMessage.content);
		return { refuse, refresh };
	}

	it("drops the chat from screen once its stream says the member no longer reaches it", async () => {
		const { refuse } = await openChatToBeRefused();
		const hidden = new NotFound({ message: userText`No such chat` });
		answerChatWith(() => Effect.fail(hidden));
		client.api.chats.messages.mockReturnValue(Effect.fail(hidden));
		client.api.chats.projectChats.mockReturnValue(chatList({ listed: false }));

		refuse(hidden);

		await waitFor(() => expect(screen.queryByText(mainMessage.content)).toBeNull());
	});

	it("asks about the member's session again once the chat's stream ends with it", async () => {
		const { refuse, refresh } = await openChatToBeRefused();

		refuse(new Unauthorized({ message: userText`Invalid or expired session` }));

		await waitFor(() => expect(refresh).toHaveBeenCalled());
	});
});
