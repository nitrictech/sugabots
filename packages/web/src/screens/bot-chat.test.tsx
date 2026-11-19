import {
	type ChatHistoryEntry,
	type ConversationActivity,
	type ConversationDetails,
	DEFAULT_CONVERSATION_HISTORY_LIMIT,
	type Message,
	type ProjectThread,
	type Run,
	streamEvent,
} from "@sugabots/contracts";
import { Forbidden, InternalServerError, NotFound } from "@sugabots/contracts/http";
import { testPerson } from "@sugabots/contracts/testing";
import { userText } from "@sugabots/errors";
import { createMemoryHistory } from "@tanstack/react-router";
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { Effect } from "effect";
import { afterEach, beforeEach, describe, expect, it, onTestFinished, vi } from "vitest";
import { createQueryClient } from "@/lib/query.ts";
import { workspacesQuery } from "@/lib/workspace.ts";
import { createAppRouter } from "@/router.tsx";
import {
	apiAnswers,
	bots,
	builtInBots,
	controlledEventStream,
	defaultProjectOf,
	juno,
	linear,
	listedThread,
	mount,
	pendingAnswer,
	projects,
	sam,
	TestApp,
	triager,
	workspace,
} from "@/test-api.tsx";
import { client } from "@/test-client.ts";

vi.mock("@/api.ts", () => import("@/test-client.ts"));

const chat: ProjectThread = {
	kind: "project_thread",
	id: "0199a3a0-0000-7000-8000-0000000000e1",
	workspaceId: linear.workspaceId,
	projectId: defaultProjectOf(linear),
	botId: linear.id,
	title: linear.name,
	archivedAt: null,
	doneAt: null,
	createdAt: "2026-09-18T08:00:00.000Z",
	updatedAt: "2026-09-18T09:30:00.000Z",
};
/** Where the bot's thread is, which its address opens. */
const conversationPage = `/suga/bots/${linear.handle}/threads/${chat.id}`;
const collaborationId = "0199a3a0-0000-7000-8000-0000000000e3";
const automationId = "0199a3a0-0000-7000-8000-0000000000e4";
const automationCollaborationId = "0199a3a0-0000-7000-8000-0000000000e7";
const automationRun: Run = {
	id: "0199a3a0-0000-7000-8000-0000000000e5",
	automationId: "0199a3a0-0000-7000-8000-0000000000e6",
	workspaceId: linear.workspaceId,
	botId: linear.id,
	conversationId: automationId,
	rootConversationId: chat.id,
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
const person = testPerson({ id: sam.id, name: sam.name });
/** In the project, but has not written in any of its conversations. */
const podmate = testPerson({ id: "0199a3a0-0000-7000-8000-000000000501", name: "Robin Vale" });
const host = {
	kind: "bot" as const,
	id: linear.id,
	name: linear.name,
	handle: linear.handle,
	color: linear.color,
	face: linear.face,
	shape: linear.shape,
};
const collaborator = {
	kind: "bot" as const,
	id: triager.id,
	name: triager.name,
	handle: triager.handle,
	color: triager.color,
	face: triager.face,
	shape: triager.shape,
};
const mainMessage: Message = {
	id: "0199a3a0-0000-7000-8000-0000000000f1",
	conversationId: chat.id,
	author: person,
	kind: "text",
	status: "complete",
	parts: [{ type: "text", text: "What changed this morning?" }],
	content: "What changed this morning?",
	createdAt: "2026-09-18T09:00:00.000Z",
};
const collaborationPart = {
	type: "collaboration" as const,
	id: "0199a3a0-0000-7000-8000-0000000000f2",
	botId: triager.id,
	botName: triager.name,
	conversationId: collaborationId,
	brief: "Check release ownership",
	status: "answered" as const,
	answer: "Sam owns the release.",
	atOffset: 19,
};
const botMessage: Message = {
	id: "0199a3a0-0000-7000-8000-0000000000f3",
	conversationId: chat.id,
	author: host,
	kind: "text",
	status: "complete",
	parts: [{ type: "text", text: "Checking ownership." }, collaborationPart],
	content: "Checking ownership.",
	createdAt: "2026-09-18T09:10:00.000Z",
};
const collaborationRequest: Message = {
	...mainMessage,
	id: "0199a3a0-0000-7000-8000-0000000000f4",
	conversationId: collaborationId,
	author: host,
	parts: [{ type: "text", text: "Check release ownership" }],
	content: "Check release ownership",
	createdAt: "2026-09-18T09:11:00.000Z",
};
const collaborationAnswer: Message = {
	...mainMessage,
	id: "0199a3a0-0000-7000-8000-0000000000f5",
	conversationId: collaborationId,
	author: collaborator,
	parts: [{ type: "text", text: "Sam owns the release." }],
	content: "Sam owns the release.",
	createdAt: "2026-09-18T09:12:00.000Z",
};
const automationMessage: Message = {
	...mainMessage,
	id: "0199a3a0-0000-7000-8000-0000000000f6",
	conversationId: automationId,
	author: host,
	parts: [
		{ type: "text", text: "The overnight review completed." },
		{
			type: "collaboration",
			id: "0199a3a0-0000-7000-8000-0000000000f8",
			botId: triager.id,
			botName: triager.name,
			conversationId: automationCollaborationId,
			brief: "Verify the overnight alerts",
			status: "answered",
			answer: "The alerts were verified.",
			atOffset: 31,
		},
	],
	content: "The overnight review completed.",
	createdAt: "2026-09-18T08:30:00.000Z",
};
const automationTriggerMessage: Message = {
	...mainMessage,
	id: "0199a3a0-0000-7000-8000-0000000000f7",
	conversationId: automationId,
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
const collaborationEntry: ChatHistoryEntry = {
	conversationId: collaborationId,
	parentConversationId: chat.id,
	kind: "collaboration",
	title: "Check release ownership",
	participants: [host, collaborator],
	status: "completed",
	automationRun: null,
	latestActivityAt: "2026-09-18T09:12:00.000Z",
};
const automationEntry: ChatHistoryEntry = {
	conversationId: automationId,
	parentConversationId: null,
	kind: "run",
	title: "Overnight review",
	participants: [host],
	status: "completed",
	automationRun: {
		runId: automationRun.id,
		automationId: automationRun.automationId,
		automationName: automationRun.automationName,
		triggerKind: automationRun.trigger.kind,
		triggeredAt: "2026-09-18T08:00:00.000Z",
	},
	latestActivityAt: "2026-09-18T08:30:00.000Z",
};
const automationCollaborationEntry: ChatHistoryEntry = {
	...collaborationEntry,
	conversationId: automationCollaborationId,
	parentConversationId: automationId,
	title: "Verify the overnight alerts",
	latestActivityAt: "2026-09-18T08:20:00.000Z",
};

/** What the thread's Details show: a summary, and who has written lately. */
const chatActivity: ConversationActivity = {
	summary: {
		content: "Chat is complete.",
		sourceMessageId: "0199a3a0-0000-7000-8000-0000000000a2",
		updatedAt: "2026-09-18T09:22:00.000Z",
	},
	context: null,
};

function details(
	id: string,
	title: string,
	kind: ConversationDetails["conversation"]["kind"],
	messages: Message[],
): ConversationDetails {
	return {
		conversation: {
			id,
			workspaceId: linear.workspaceId,
			projectId: null,
			botId: kind === "collaboration" ? triager.id : linear.id,
			rootConversationId: chat.id,
			kind,
			title,
			status: "done",
			parentConversationId: kind === "collaboration" ? chat.id : null,
			startedById: sam.id,
			doneAt: null,
			createdAt: "2026-09-18T08:00:00.000Z",
			updatedAt: "2026-09-18T09:22:00.000Z",
		},
		automationRun: kind === "run" ? automationRun : null,
		participants: kind === "collaboration" ? [host, collaborator] : [person, host],
		projectBots: [host, collaborator],
		members: [person, podmate],
		messages,
		olderMessagesCursor: null,
		queuedSince: null,
		reads: [],
	};
}

/** Linear Handler's threads, with this one in them when `listed`. */
function chatList({ listed }: { listed: boolean }) {
	return Effect.succeed({
		bot: linear,
		threads: listed ? [listedThread(chat)] : [],
		automations: [],
		summary: null,
	});
}

/**
 * Answers the thread's own details with `answer`, leaving every other
 * conversation, such as an inline collaboration, to the usual answers.
 */
function answerThreadWith(answer: () => ReturnType<typeof client.api.conversations.get>) {
	const usual = client.api.conversations.get.getMockImplementation();
	client.api.conversations.get.mockImplementation(
		(request: { params: { conversationId: string } }) =>
			request.params.conversationId === chat.id ? answer() : usual?.(request),
	);
}

/** The thread's messages, with `later` after the usual two. */
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
	client.api.chats.botThreads.mockReturnValue(chatList({ listed: true }));
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
			items: [collaborationEntry, automationEntry, automationCollaborationEntry],
			nextCursor: null,
		}),
	);
	client.api.conversations.activity.mockImplementation(
		({ params }: { params: { conversationId: string } }) =>
			params.conversationId === chat.id
				? Effect.succeed(chatActivity)
				: Effect.fail(new NotFound({ message: userText`No such conversation` })),
	);
	client.api.conversations.get.mockImplementation(
		({ params }: { params: { conversationId: string } }) => {
			switch (params.conversationId) {
				case collaborationId:
					return Effect.succeed(
						details(collaborationId, collaborationEntry.title, "collaboration", [
							collaborationRequest,
							collaborationAnswer,
						]),
					);
				case automationId:
					return Effect.succeed(
						details(automationId, automationEntry.title, "run", [
							automationTriggerMessage,
							automationMessage,
						]),
					);
				case automationCollaborationId: {
					const nested = details(
						automationCollaborationId,
						automationCollaborationEntry.title,
						"collaboration",
						[
							{
								...collaborationRequest,
								id: "0199a3a0-0000-7000-8000-0000000000f9",
								conversationId: automationCollaborationId,
								content: "Verify the overnight alerts",
								parts: [{ type: "text", text: "Verify the overnight alerts" }],
							},
							{
								...collaborationAnswer,
								id: "0199a3a0-0000-7000-8000-0000000000fa",
								conversationId: automationCollaborationId,
								content: "The alerts were verified.",
								parts: [{ type: "text", text: "The alerts were verified." }],
							},
						],
					);
					return Effect.succeed({
						...nested,
						conversation: { ...nested.conversation, parentConversationId: automationId },
					});
				}
				default:
					return Effect.succeed(
						details(chat.id, "Chat", "project_thread", [mainMessage, botMessage]),
					);
			}
		},
	);
}

/** Goes to the thread's bot's settings, which unmounts the thread, and back to its composer. */
async function leaveAndReturn(router: ReturnType<typeof mount>): Promise<HTMLElement> {
	await router.navigate({ to: `/suga/settings/bots/${linear.handle}` });
	await waitFor(() => expect(screen.queryByLabelText(`Message ${linear.name}`)).toBeNull());
	await router.navigate({ to: conversationPage });
	return await screen.findByLabelText(`Message ${linear.name}`);
}

/** Writes `text` into the message box, as typing it would. */
function writeDraft(box: HTMLElement, text: string) {
	box.textContent = text;
	fireEvent.input(box);
}

/**
 * A `ResizeObserver` for one test, which jsdom lacks: `of(element)` tells
 * whatever is watching `element` that it changed size.
 */
function watchResizes() {
	const watching = new Map<Element, ResizeObserverCallback>();
	vi.stubGlobal(
		"ResizeObserver",
		class {
			constructor(private readonly callback: ResizeObserverCallback) {}
			observe(element: Element) {
				watching.set(element, this.callback);
			}
			unobserve(element: Element) {
				watching.delete(element);
			}
			disconnect() {
				for (const [element, callback] of watching) {
					if (callback === this.callback) watching.delete(element);
				}
			}
		},
	);
	onTestFinished(() => {
		vi.unstubAllGlobals();
	});
	return {
		of(element: Element) {
			watching.get(element)?.([], {} as ResizeObserver);
		},
	};
}

beforeEach(() => {
	localStorage.clear();
	apiAnswers();
	chatAnswers();
});

afterEach(() => {
	cleanup();
	vi.clearAllMocks();
});

describe("a bot's thread", () => {
	it("shows the thread's messages and inline collaborations", async () => {
		mount(conversationPage);

		expect(await screen.findByText(mainMessage.content)).toBeDefined();
		expect(screen.getByText(botMessage.content)).toBeDefined();
		// A bot's thread shows a collaboration inline: what the two bots said, and a way to open it.
		const collaboration = screen.getByRole("region", {
			name: `${linear.name} asked ${triager.name} for help`,
		});
		expect(await within(collaboration).findByText(collaborationAnswer.content)).toBeDefined();
		expect(
			within(collaboration).getByRole("button", {
				name: `Open Collaboration: ${linear.name} and ${triager.name}`,
			}),
		).toBeDefined();
	});

	it("asks for a thread page's projects, bots and the bot's threads at once, each a single time, on its first load", async () => {
		// Reading the chat refreshes its list; held, so only the page's first load is counted.
		client.api.chats.markRead.mockReturnValue(pendingAnswer().effect);
		// As /me leaves the cache when the app starts.
		const queries = createQueryClient();
		queries.setQueryData(workspacesQuery.queryKey, [workspace]);
		const path = conversationPage;
		render(
			<TestApp
				router={createAppRouter({ history: createMemoryHistory({ initialEntries: [path] }) })}
				queries={queries}
				session={{ user: sam, error: undefined, refresh: vi.fn() }}
			/>,
		);

		await screen.findByText(mainMessage.content);
		expect(client.api.projects.list).toHaveBeenCalledOnce();
		expect(client.api.bots.list).toHaveBeenCalledOnce();
		expect(
			client.api.chats.botThreads.mock.calls.filter(
				([request]) => request.params.botId === linear.id,
			),
		).toHaveLength(1);
	});

	it("opens a thread its bot's list does not have yet", async () => {
		client.api.chats.botThreads.mockReturnValue(chatList({ listed: false }));
		mount(conversationPage);

		expect(await screen.findByText(mainMessage.content)).toBeDefined();
	});

	it("shows automation runs among the thread's messages", async () => {
		client.api.chats.messages.mockReturnValue(
			Effect.succeed({
				items: [
					{
						kind: "run",
						id: automationRun.id,
						conversationId: automationId,
						automationName: automationRun.automationName,
						triggerKind: "webhook",
						createdAt: automationRun.acceptedAt,
					},
				],
				nextCursor: null,
			}),
		);
		mount(conversationPage);

		const activity = await screen.findByRole("button", {
			name: new RegExp(`^Open Automation run: ${automationRun.automationName}`),
		});
		expect(activity.textContent).toContain(automationRun.automationName);
		expect(screen.queryByText(`Say hello to ${linear.name}`)).toBeNull();
	});

	it("sends a message in the thread", async () => {
		client.api.chats.send.mockReturnValue(
			Effect.succeed({ message: mainMessage, routing: { status: "routed" } }),
		);
		mount(conversationPage);
		const messages = await screen.findByRole("log", { name: "Chat messages" });
		Object.defineProperty(messages, "scrollHeight", { configurable: true, value: 1_200 });
		messages.scrollTop = 100;
		const composer = await screen.findByLabelText(`Message ${linear.name}`);
		writeDraft(composer, "  Send the update  ");
		fireEvent.click(screen.getByRole("button", { name: "Send message" }));

		await waitFor(() =>
			expect(client.api.chats.send).toHaveBeenCalledWith({
				params: { conversationId: chat.id },
				payload: { id: expect.any(String), message: "Send the update" },
			}),
		);
		await waitFor(() => expect(messages.scrollTop).toBe(1_200));
	});

	it("with other people in the thread, says the bot stays out only of a draft mentioning just people", async () => {
		const shared = details(chat.id, "Chat", "project_thread", [mainMessage]);
		client.api.conversations.get.mockReturnValue(
			Effect.succeed({ ...shared, participants: [...shared.participants, podmate] }),
		);
		mount(conversationPage);
		const composer = await screen.findByLabelText(`Message ${linear.name}`);
		expect(screen.queryByText(`${linear.name} won't reply.`)).toBeNull();

		writeDraft(composer, `@${podmate.handle} can you check?`);

		expect(await screen.findByText(`${linear.name} won't reply.`)).toBeTruthy();
		const box = screen.getByLabelText(`Message ${podmate.name}`);
		// The finished mention is drawn in the box as the person's handle, as a sent message draws it.
		expect(within(box).getByText(`@${podmate.handle}`)).toBeTruthy();

		writeDraft(box, `@${podmate.handle} and @${linear.handle}, can you check?`);

		await waitFor(() => expect(screen.queryByText(`${linear.name} won't reply.`)).toBeNull());
		expect(screen.getByLabelText(`Message ${linear.name}`)).toBeTruthy();
	});

	it("offers the project's people and bots to mention, so the chat's bot can bring one in, but not you", async () => {
		mount(conversationPage);
		const composer = await screen.findByLabelText(`Message ${linear.name}`);
		writeDraft(composer, "@");

		const list = within(await screen.findByRole("listbox"));
		expect(list.getByRole("option", { name: new RegExp(linear.name) })).toBeTruthy();
		expect(list.getByRole("option", { name: new RegExp(podmate.name) })).toBeTruthy();
		expect(list.getByRole("option", { name: new RegExp(triager.name) })).toBeTruthy();
		expect(list.queryByRole("option", { name: new RegExp(sam.name) })).toBeNull();
		// After the people and bots come the two groups, which are not people the project has.
		expect(list.getByRole("option", { name: /@here/ })).toBeTruthy();
		expect(list.getByRole("option", { name: /@channel/ })).toBeTruthy();
		expect(list.getAllByRole("option")).toHaveLength(5);
	});

	it("offers no @here or @channel when nobody else could be notified", async () => {
		client.api.conversations.get.mockReturnValue(
			Effect.succeed({ ...details(chat.id, "Chat", "project_thread", [mainMessage]), members: [] }),
		);
		mount(conversationPage);
		const composer = await screen.findByLabelText(`Message ${linear.name}`);
		writeDraft(composer, "@");

		const list = within(await screen.findByRole("listbox"));
		expect(list.getByRole("option", { name: new RegExp(linear.name) })).toBeTruthy();
		expect(list.queryByRole("option", { name: /@here|@channel/ })).toBeNull();
	});

	it("offers no composer to a bot with no model, and says where to choose one", async () => {
		client.api.bots.list.mockReturnValue(
			Effect.succeed(bots.map((one) => (one.id === linear.id ? { ...one, model: null } : one))),
		);
		mount(conversationPage);

		expect(await screen.findByText(/has no model yet, so it cannot answer/)).toBeDefined();
		expect(screen.getByRole("link", { name: "Choose a model" }).getAttribute("href")).toBe(
			`/suga/settings/bots/${linear.handle}`,
		);
		expect(screen.queryByLabelText(`Message ${linear.name}`)).toBeNull();
	});

	it("clears the composer while the message is still in flight", async () => {
		const posting = pendingAnswer();
		client.api.chats.send.mockReturnValue(posting.effect);
		mount(conversationPage);
		const composer = await screen.findByLabelText(`Message ${linear.name}`);
		writeDraft(composer, "Send the update");
		fireEvent.click(screen.getByRole("button", { name: "Send message" }));

		await waitFor(() => expect(composer.textContent).toBe(""));
		posting.answer(Effect.succeed({ message: mainMessage, routing: { status: "routed" } }));
	});

	it("puts the draft back when the message could not be sent", async () => {
		client.api.chats.messages.mockImplementation(() =>
			Effect.succeed({ items: [{ kind: "message", message: mainMessage }], nextCursor: null }),
		);
		client.api.chats.history.mockImplementation(() =>
			Effect.succeed({ items: [], nextCursor: null }),
		);
		client.api.chats.send.mockReturnValue(
			Effect.fail(new InternalServerError({ message: userText`Nope` })),
		);
		mount(conversationPage);
		const composer = await screen.findByLabelText(`Message ${linear.name}`);
		writeDraft(composer, "Send the update");
		fireEvent.click(screen.getByRole("button", { name: "Send message" }));

		await screen.findByText("Message not sent. Your draft is still here.");
		expect(composer.textContent).toBe("Send the update");
	});

	it("keeps an unsent draft while you are elsewhere, with the cursor at its end", async () => {
		const router = mount(conversationPage);
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
		const router = mount(conversationPage);
		writeDraft(await screen.findByLabelText(`Message ${linear.name}`), "Send the update");
		fireEvent.click(screen.getByRole("button", { name: "Send message" }));
		await waitFor(() => expect(client.api.chats.send).toHaveBeenCalled());

		const composer = await leaveAndReturn(router);
		expect(composer.textContent).toBe("");
	});

	it("fetches the thread again when its workspace's events start over", async () => {
		const updates = controlledEventStream();
		client.events.workspace.mockReturnValue(updates.stream);
		mount(conversationPage);
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

	it("keeps following the latest message while the bot works, and when it answers", async () => {
		const updates = controlledEventStream();
		client.events.conversation.mockReturnValue(updates.stream);
		mount(conversationPage);
		const messages = await screen.findByRole("log", { name: "Chat messages" });
		let scrollHeight = 1_200;
		Object.defineProperties(messages, {
			scrollHeight: { configurable: true, get: () => scrollHeight },
			clientHeight: { configurable: true, value: 400 },
		});
		messages.scrollTop = 800;
		fireEvent.scroll(messages);
		await waitFor(() => expect(client.events.conversation).toHaveBeenCalledWith(chat.id));

		const streaming = {
			...botMessage,
			id: "0199a3a0-0000-7000-8000-0000000000fb",
			status: "streaming" as const,
			content: "Starting",
			parts: [{ type: "text" as const, text: "Starting" }],
			createdAt: "2026-09-18T09:20:00.000Z",
		};
		scrollHeight = 1_400;
		updates.emit(streamEvent("message.created", { conversationId: chat.id, message: streaming }));
		await screen.findByRole("status", { name: `${linear.name} is typing` });
		await waitFor(() => expect(messages.scrollTop).toBe(1_400));

		scrollHeight = 1_700;
		updates.emit(
			streamEvent("message.completed", {
				conversationId: chat.id,
				messageId: streaming.id,
				content: "Starting the response",
				status: "complete",
			}),
		);
		await screen.findByText("Starting the response");
		await waitFor(() => expect(messages.scrollTop).toBe(1_700));
	});

	it("shows a file the bot attaches while it still answers, and keeps it as the answer goes on", async () => {
		const updates = controlledEventStream();
		client.events.conversation.mockReturnValue(updates.stream);
		mount(conversationPage);
		await screen.findByRole("log", { name: "Chat messages" });
		await waitFor(() => expect(client.events.conversation).toHaveBeenCalledWith(chat.id));
		const streaming = {
			...botMessage,
			id: "0199a3a0-0000-7000-8000-0000000000fc",
			status: "streaming" as const,
			content: "Here it is",
			parts: [{ type: "text" as const, text: "Here it is" }],
			createdAt: "2026-09-18T09:20:00.000Z",
		};
		updates.emit(streamEvent("message.created", { conversationId: chat.id, message: streaming }));
		await screen.findByRole("status", { name: `${linear.name} is typing` });

		// Before the reply's words are settled enough to show, its file already is.
		updates.emit(
			streamEvent("message.files_changed", {
				conversationId: chat.id,
				messageId: streaming.id,
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
		expect(await screen.findByRole("link", { name: "Download q3-report.csv" })).toBeDefined();

		updates.emit(
			streamEvent("message.delta", {
				conversationId: chat.id,
				messageId: streaming.id,
				offset: streaming.content.length,
				text: ", with the totals.",
			}),
		);
		updates.emit(
			streamEvent("message.completed", {
				conversationId: chat.id,
				messageId: streaming.id,
				content: "Here it is, with the totals.",
				status: "complete",
			}),
		);
		await screen.findByText("Here it is, with the totals.");
		expect(screen.getByRole("link", { name: "Download q3-report.csv" })).toBeDefined();
	});

	it("shows the reply that finished while you were elsewhere", async () => {
		const writing: Message = {
			...botMessage,
			id: "0199a3a0-0000-7000-8000-0000000000fb",
			status: "streaming",
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
		const conversationWith = (reply: Message) =>
			Effect.succeed(details(chat.id, "Chat", "project_thread", [mainMessage, reply]));
		answerThreadWith(() => conversationWith(writing));
		const router = mount(conversationPage);
		await screen.findByRole("status", { name: `${linear.name} is typing` });

		answerThreadWith(() => conversationWith(answered));
		await leaveAndReturn(router);

		await screen.findByText("Checkout timeouts are tracked.");
		expect(screen.queryByRole("status", { name: `${linear.name} is typing` })).toBeNull();
	});

	it("keeps the latest message in view when the chat gets shorter, as when a phone's keyboard opens", async () => {
		const resizes = watchResizes();
		let height = 600;
		const heightOf = vi
			.spyOn(HTMLElement.prototype, "clientHeight", "get")
			.mockImplementation(() => height);
		onTestFinished(() => heightOf.mockRestore());
		mount(conversationPage);
		// The chat loads after the first render, so the log is not there to watch until it has.
		const messages = await screen.findByRole("log", { name: "Chat messages" });
		messages.scrollTop = 800;

		height = 300;
		resizes.of(messages);

		expect(messages.scrollTop).toBe(1_100);
	});

	describe("reading the chat", () => {
		function windowFocused(focused: boolean) {
			const hasFocus = vi.spyOn(document, "hasFocus").mockReturnValue(focused);
			onTestFinished(() => hasFocus.mockRestore());
			return hasFocus;
		}

		it("leaves the chat unread while another window has focus, and reads it on coming back", async () => {
			const hasFocus = windowFocused(false);
			mount(conversationPage);
			await screen.findByText(mainMessage.content);
			expect(client.api.chats.markRead).not.toHaveBeenCalled();

			hasFocus.mockReturnValue(true);
			fireEvent.focus(window);

			await waitFor(() =>
				expect(client.api.chats.markRead).toHaveBeenCalledWith({
					params: { conversationId: chat.id },
				}),
			);
		});

		it("leaves a reply unread while scrolled back through the chat, and reads it at the latest message", async () => {
			windowFocused(true);
			const updates = controlledEventStream();
			client.events.conversation.mockReturnValue(updates.stream);
			mount(conversationPage);
			const messages = await screen.findByRole("log", { name: "Chat messages" });
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
					conversationId: chat.id,
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
			status: "streaming",
			content: "",
			parts: [],
			createdAt: "2026-09-18T09:20:00.000Z",
		};
		const followUp: Message = {
			...mainMessage,
			id: "0199a3a0-0000-7000-8000-0000000000fd",
			author: testPerson({ id: "0199a3a0-0000-7000-8000-0000000000fe", name: "Jay Park" }),
			content: "Is the Stripe webhook part of it?",
			parts: [{ type: "text", text: "Is the Stripe webhook part of it?" }],
			createdAt: "2026-09-18T09:21:00.000Z",
		};
		/** The thread as the server has it, with `queuedSince` when a turn started waiting. */
		const serverHas = (queuedSince: string | null) =>
			client.api.conversations.get.mockReturnValue(
				Effect.succeed({
					...details(chat.id, "Chat", "project_thread", [mainMessage, writing, followUp]),
					queuedSince,
				}),
			);

		async function watchWhileReplying() {
			const updates = controlledEventStream();
			client.events.conversation.mockReturnValue(updates.stream);
			serverHas(null);
			mount(conversationPage);
			await screen.findByRole("log", { name: "Chat messages" });
			await waitFor(() => expect(client.events.conversation).toHaveBeenCalledWith(chat.id));
			updates.emit(streamEvent("message.created", { conversationId: chat.id, message: writing }));
			updates.emit(streamEvent("message.created", { conversationId: chat.id, message: followUp }));
			await screen.findByText("Is the Stripe webhook part of it?");
			return updates;
		}

		it("says a message waits for the next reply, until that reply starts", async () => {
			const updates = await watchWhileReplying();

			serverHas(followUp.createdAt);
			updates.emit(streamEvent("conversation.changed", { conversationId: chat.id }));
			await screen.findByRole("article", { name: "Jay Park, queued" });

			serverHas(null);
			updates.emit(
				streamEvent("turn.started", {
					conversationId: chat.id,
					turnId: "0199a3a0-0000-7000-8000-0000000000ff",
					botId: linear.id,
				}),
			);
			await waitFor(() =>
				expect(screen.queryByRole("article", { name: "Jay Park, queued" })).toBeNull(),
			);
		});

		it("does not say a message waits when the server queued no reply for it", async () => {
			await watchWhileReplying();

			expect(screen.queryByRole("article", { name: "Jay Park, queued" })).toBeNull();
		});
	});

	it("shows what the bot said before a collaboration while it waits on the answer", async () => {
		// The lead-in used to wait for the whole reply, then land above the
		// collaboration row and the typing line that had already been drawn.
		const waiting = {
			...botMessage,
			status: "streaming" as const,
			parts: [
				{ type: "text" as const, text: "Checking ownership." },
				{ ...collaborationPart, status: "waiting" as const, answer: null },
			],
		};
		client.api.chats.messages.mockReturnValue(
			Effect.succeed({
				items: [
					{ kind: "message", message: mainMessage },
					{ kind: "message", message: waiting },
				],
				nextCursor: null,
			}),
		);
		answerThreadWith(() =>
			Effect.succeed(details(chat.id, "Chat", "project_thread", [mainMessage, waiting])),
		);
		mount(conversationPage);

		const leadIn = await screen.findByText("Checking ownership.");
		const collaboration = screen.getByRole("region", {
			name: `${linear.name} asked ${triager.name} for help`,
		});
		const follows = (first: Node, second: Node) =>
			Boolean(first.compareDocumentPosition(second) & Node.DOCUMENT_POSITION_FOLLOWING);
		expect(follows(leadIn, collaboration)).toBe(true);
		// While the collaboration runs the bot says nothing else; the collaboration shows what goes on.
		expect(screen.queryByRole("status", { name: /is typing/ })).toBeNull();
	});

	it("opens a read-only collaboration panel from an inline part", async () => {
		const router = mount(conversationPage);
		fireEvent.click(
			await screen.findByRole("button", {
				name: new RegExp(`^Open Collaboration: ${linear.name} .*${triager.name}`),
			}),
		);

		const panel = await screen.findByRole("complementary", { name: collaborationEntry.title });
		const request = within(panel).getByRole("article", { name: new RegExp(linear.name) });
		expect(within(request).getByText(collaborationRequest.content)).toBeDefined();
		expect(within(panel).queryByText("The request")).toBeNull();
		const answer = within(panel).getByRole("article", { name: new RegExp(triager.name) });
		expect(within(answer).getByText(collaborationAnswer.content)).toBeDefined();
		expect(within(panel).getByText(`${linear.name} and ${triager.name}`)).toBeDefined();
		expect(within(panel).queryByRole("textbox")).toBeNull();
		expect(within(panel).getByText(/Bots talk here on their own/)).toBeDefined();
		await waitFor(() => expect(router.state.location.search.item).toBe(collaborationId));
	});

	it("opens a collaboration at the beginning instead of scrolling to the latest message", async () => {
		const originalScrollHeight = Object.getOwnPropertyDescriptor(
			HTMLElement.prototype,
			"scrollHeight",
		);
		Object.defineProperty(HTMLElement.prototype, "scrollHeight", {
			configurable: true,
			get: () => 1_200,
		});
		try {
			mount(conversationPage);
			fireEvent.click(
				await screen.findByRole("button", {
					name: new RegExp(`^Open Collaboration: ${linear.name} .*${triager.name}`),
				}),
			);

			const timeline = await screen.findByRole("log", { name: "Conversation messages" });
			expect(timeline.scrollTop).toBe(0);
		} finally {
			if (originalScrollHeight) {
				Object.defineProperty(HTMLElement.prototype, "scrollHeight", originalScrollHeight);
			} else {
				Reflect.deleteProperty(HTMLElement.prototype, "scrollHeight");
			}
		}
	});

	it("never opens an automation run beside the chat, even from the item query", async () => {
		mount(`${conversationPage}?item=${automationId}`);

		await screen.findByText(mainMessage.content);
		expect(screen.queryByRole("complementary", { name: automationEntry.title })).toBeNull();
	});

	it("offers no way back to a run from its collaboration beside the chat", async () => {
		mount(`${conversationPage}?item=${automationCollaborationId}`);

		const collaborationPanel = await screen.findByRole("complementary", {
			name: automationCollaborationEntry.title,
		});
		expect(
			within(collaborationPanel).queryByRole("button", { name: "Back to automation" }),
		).toBeNull();
	});

	it("opens with whom the chat is with, when there is nothing older", async () => {
		client.api.chats.messages.mockReturnValue(Effect.succeed({ items: [], nextCursor: null }));
		client.api.conversations.get.mockReturnValue(
			Effect.succeed(details(chat.id, "Chat", "project_thread", [])),
		);
		mount(conversationPage);

		expect(await screen.findByRole("heading", { name: "Chat", level: 2 })).toBeDefined();
		expect(screen.getByText(`With ${linear.name}`)).toBeDefined();
	});

	it("opens Details from the thread's name, and leads back to its bot", async () => {
		mount(conversationPage);

		const name = await screen.findByRole("button", { name: "Chat" });
		expect(screen.getByRole("link", { name: `Back to ${linear.name}` }).getAttribute("href")).toBe(
			`/suga/bots/${linear.handle}`,
		);
		fireEvent.click(name);

		expect(await screen.findByRole("complementary", { name: "Details" })).toBeDefined();
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
		const router = mount(conversationPage);

		expect(await screen.findByRole("complementary", { name: "Details" })).toBeDefined();
		fireEvent.click(screen.getByRole("button", { name: "Details", pressed: true }));
		await waitFor(() =>
			expect(screen.queryByRole("complementary", { name: "Details" })).toBeNull(),
		);
		await leaveAndReturn(router);

		expect(screen.getByRole("button", { name: "Details", pressed: false })).toBeDefined();
		expect(screen.queryByRole("complementary", { name: "Details" })).toBeNull();
	});

	/**
	 * The way back to the thread a settings page was opened from: the Back above
	 * the page on a phone. Wide, the trail and the sidebar go back instead, so
	 * the bar is hidden there by style, which the test DOM does not apply.
	 */
	async function backToThread() {
		const [back] = await within(await screen.findByRole("main")).findAllByRole("link", {
			name: "Thread",
		});
		if (!back) throw new Error("No way back to the thread");
		return back;
	}

	it("leads from its bot's settings back to the thread they were opened from", async () => {
		const router = mount(conversationPage);
		fireEvent.click(await screen.findByRole("button", { name: "Details" }));
		const details = await screen.findByRole("complementary", { name: "Details" });

		fireEvent.click(within(details).getByRole("link", { name: "Settings" }));
		await screen.findByRole("heading", { name: linear.name });
		fireEvent.click(await backToThread());

		await waitFor(() => expect(router.state.location.pathname).toBe(conversationPage));
	});

	it("leads from a person's name to their member page, and back to the thread", async () => {
		answerMessagesWith({
			...mainMessage,
			id: "0199a3a0-0000-7000-8000-0000000000fa",
			author: testPerson({ id: juno.id, name: juno.name }),
			createdAt: "2026-09-18T09:15:00.000Z",
		});
		const router = mount(conversationPage);
		const messages = await screen.findByRole("log", { name: "Chat messages" });

		fireEvent.click(await within(messages).findByRole("link", { name: juno.name }));
		await waitFor(() =>
			expect(router.state.location.pathname).toBe(
				"/suga/settings/members/0199a3a0-0000-7000-8000-0000000000d2",
			),
		);
		fireEvent.click(await backToThread());

		await waitFor(() => expect(router.state.location.pathname).toBe(conversationPage));
	});

	it("leads from a bot's name to its settings, and back to the thread", async () => {
		answerMessagesWith({
			...mainMessage,
			id: "0199a3a0-0000-7000-8000-0000000000fa",
			author: collaborator,
			createdAt: "2026-09-18T09:15:00.000Z",
		});
		const router = mount(conversationPage);
		const messages = await screen.findByRole("log", { name: "Chat messages" });

		fireEvent.click(
			(await within(messages).findAllByRole("link", { name: triager.name }))[0] as HTMLElement,
		);
		await screen.findByRole("heading", { name: triager.name });
		expect(router.state.location.pathname).toBe(`/suga/settings/bots/${triager.handle}`);
		fireEvent.click(await backToThread());

		await waitFor(() => expect(router.state.location.pathname).toBe(conversationPage));
	});

	it("lists the people in a thread with more than one in it from its header, the viewer as you", async () => {
		const shared = details(chat.id, "Chat", "project_thread", [mainMessage]);
		client.api.conversations.get.mockReturnValue(
			Effect.succeed({ ...shared, participants: [...shared.participants, podmate] }),
		);
		mount(conversationPage);

		fireEvent.click(await screen.findByRole("button", { name: "2 people in this thread" }));

		const people = await screen.findByRole("menu");
		const [first, second, ...rest] = within(people).getAllByRole("menuitem");
		expect(first?.textContent).toContain("(you)");
		expect(second?.textContent).toContain(podmate.name);
		expect(rest).toEqual([]);
	});

	it("closes a direct-linked collaboration without leaving the thread", async () => {
		const router = mount(`${conversationPage}?item=${collaborationId}`);
		const panel = await screen.findByRole("complementary", { name: collaborationEntry.title });
		expect(within(panel).getByRole("heading", { name: "Collaboration" })).toBeDefined();
		fireEvent.click(within(panel).getByRole("button", { name: "Close" }));

		await waitFor(() =>
			expect(screen.queryByRole("complementary", { name: collaborationEntry.title })).toBeNull(),
		);
		expect(router.state.location.pathname).toBe(conversationPage);
	});
});

describe("a message opened from Inbox", () => {
	const older: Message = {
		...mainMessage,
		id: "0199a3a0-0000-7000-8000-000000000201",
		parts: [{ type: "text", text: "Can you look at the release?" }],
		content: "Can you look at the release?",
		createdAt: "2026-09-17T09:00:00.000Z",
	};
	const opened = (messageId: string) => `/suga/inbox/${chat.id}?message=${messageId}`;

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

	it("jumps to the message a notification names, at the thread's own address", async () => {
		mount(`/suga/threads/${chat.id}?message=${older.id}`);

		const row = (await screen.findByText(older.content)).closest("[data-message-id]");
		await waitFor(() => expect(document.activeElement).toBe(row));
	});

	it("shows the run a notification names as the page, at the thread's own address", async () => {
		mount(`${conversationPage}?itemPage=${automationId}`);

		expect(
			await screen.findByRole("heading", { name: automationRun.automationName }),
		).toBeDefined();
		expect(screen.queryByRole("log", { name: "Chat messages" })).toBeNull();
		expect(screen.getByRole("link", { name: `Back to ${linear.name}` })).toBeDefined();
	});

	it("says so when the message cannot be found in the chat", async () => {
		mount(opened("0199a3a0-0000-7000-8000-000000000299"));

		expect(
			await screen.findByText("Could not find the message you opened in this chat."),
		).toBeDefined();
	});

	it("keeps the chat, with no run beside it, when its address names a run", async () => {
		mount(`${opened(mainMessage.id)}&item=${automationId}`);

		expect(await screen.findByRole("log", { name: "Chat messages" })).toBeDefined();
		expect(screen.queryByRole("complementary", { name: automationEntry.title })).toBeNull();
	});

	it("shows an automation run chosen in Inbox as a page of its own, with the way back and to its chat", async () => {
		mount(`/suga/inbox/${chat.id}?itemPage=${automationId}`);

		expect(
			await screen.findByRole("heading", { name: automationRun.automationName }),
		).toBeDefined();
		expect(screen.queryByRole("log", { name: "Chat messages" })).toBeNull();
		expect(screen.getByRole("link", { name: "Back to Inbox" }).getAttribute("href")).toBe(
			"/suga/inbox",
		);
		expect(screen.getByRole("link", { name: "Open thread" }).getAttribute("href")).toBe(
			conversationPage,
		);
	});

	it("shows a collaboration in a project's thread as the page, from Inbox and at the conversation's address, and beside its chat", async () => {
		const project = projects[1] as (typeof projects)[number];
		const projectChat = {
			kind: "project_thread" as const,
			id: chat.id,
			workspaceId: chat.workspaceId,
			title: project.name,
			createdAt: chat.createdAt,
			updatedAt: chat.updatedAt,
			projectId: project.id,
			botId: null,
			archivedAt: null,
			doneAt: null,
		};
		client.api.chats.list.mockReturnValue(Effect.succeed({ chats: [listedThread(projectChat)] }));
		const collaboration = details(collaborationId, collaborationEntry.title, "collaboration", [
			collaborationRequest,
			collaborationAnswer,
		]);
		const inProject = (one: ConversationDetails): ConversationDetails => ({
			...one,
			conversation: { ...one.conversation, projectId: project.id },
		});
		const main = details(chat.id, project.name, "project_thread", [mainMessage]);
		client.api.conversations.get.mockImplementation(
			({ params }: { params: { conversationId: string } }) =>
				Effect.succeed(
					params.conversationId === collaborationId
						? inProject(collaboration)
						: inProject({ ...main, conversation: { ...main.conversation, botId: null } }),
				),
		);
		const projectPage = `/suga/projects/${project.slug}/${chat.id}`;

		mount(`/suga/inbox/${chat.id}?itemPage=${collaborationId}`);
		expect(await screen.findByRole("heading", { name: "Collaboration" })).toBeDefined();
		expect(screen.queryByRole("log", { name: "Chat messages" })).toBeNull();
		expect(screen.getByRole("link", { name: "Open thread" }).getAttribute("href")).toBe(
			projectPage,
		);
		cleanup();

		mount(`${projectPage}?itemPage=${collaborationId}`);
		expect(await screen.findByRole("heading", { name: "Collaboration" })).toBeDefined();
		expect(screen.queryByRole("log", { name: "Chat messages" })).toBeNull();
		expect(screen.getByRole("link", { name: "Open conversation" }).getAttribute("href")).toBe(
			projectPage,
		);
		cleanup();

		// Asked to open beside the project's chat, as Approvals does, it opens there.
		mount(`${projectPage}?item=${collaborationId}`);
		expect(await screen.findByRole("log", { name: "Chat messages" })).toBeDefined();
		expect(
			await screen.findByRole("complementary", { name: collaborationEntry.title }),
		).toBeDefined();
	});

	it("opens a run's automation on its bot's automations page, where it is changed, from the run's header", async () => {
		mount(`/suga/inbox/${chat.id}?itemPage=${automationId}`);

		const settings = await screen.findByRole("link", { name: "Automation settings" });
		expect(settings.getAttribute("href")).toBe(
			`/suga/bots/${linear.handle}/automations/${automationRun.automationId}`,
		);
	});

	it("reads the automation run chosen in Inbox once the window has focus, and not the rest of its chat", async () => {
		const hasFocus = vi.spyOn(document, "hasFocus").mockReturnValue(false);
		onTestFinished(() => hasFocus.mockRestore());
		mount(`/suga/inbox/${chat.id}?itemPage=${automationId}`);
		await screen.findByRole("heading", { name: automationRun.automationName });
		expect(client.api.chats.markItemRead).not.toHaveBeenCalled();

		hasFocus.mockReturnValue(true);
		fireEvent.focus(window);

		await waitFor(() =>
			expect(client.api.chats.markItemRead).toHaveBeenCalledWith({
				params: { conversationId: automationId },
			}),
		);
		expect(client.api.chats.markRead).not.toHaveBeenCalled();
	});

	it("ignores an address naming something other than a message", async () => {
		mount(`/suga/inbox/${chat.id}?message=a%22b`);

		expect(await screen.findByText(mainMessage.content)).toBeDefined();
		expect(screen.queryByText("Could not find the message you opened in this chat.")).toBeNull();
	});
});

describe("people typing in the thread", () => {
	const junoInThread = testPerson({ id: juno.id, name: juno.name });
	const junoTyping = streamEvent("person.typing", {
		conversationId: chat.id,
		person: junoInThread,
	});

	async function watchConversation() {
		const updates = controlledEventStream();
		client.events.conversation.mockReturnValue(updates.stream);
		mount(conversationPage);
		await waitFor(() => expect(client.events.conversation).toHaveBeenCalledWith(chat.id));
		return updates;
	}

	afterEach(() => {
		vi.useRealTimers();
	});

	it("shows someone else typing until their message arrives", async () => {
		const updates = await watchConversation();

		updates.emit(junoTyping);
		await screen.findByRole("status", { name: "Juno is typing" });

		updates.emit(
			streamEvent("message.created", {
				conversationId: chat.id,
				message: {
					...mainMessage,
					id: "0199a3a0-0000-7000-8000-0000000000fc",
					author: junoInThread,
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
		const updates = await watchConversation();

		updates.emit(junoTyping);
		await screen.findByRole("status", { name: "Juno is typing" });

		await vi.advanceTimersByTimeAsync(7_000);
		await waitFor(() =>
			expect(screen.queryByRole("status", { name: "Juno is typing" })).toBeNull(),
		);
	});

	it("does not show you your own typing", async () => {
		const updates = await watchConversation();

		updates.emit(streamEvent("person.typing", { conversationId: chat.id, person }));
		updates.emit(junoTyping);

		await screen.findByRole("status", { name: "Juno is typing" });
		expect(screen.queryByRole("status", { name: /Sam/ })).toBeNull();
	});

	it("does not say you are typing just because a draft was kept from before", async () => {
		const router = mount(conversationPage);
		writeDraft(await screen.findByLabelText(`Message ${linear.name}`), "Half a thought");
		await waitFor(() => expect(client.api.events.typing).toHaveBeenCalledTimes(1));
		client.api.events.typing.mockClear();
		client.events.conversation.mockClear();

		await leaveAndReturn(router);
		await waitFor(() => expect(client.events.conversation).toHaveBeenCalledWith(chat.id));
		expect(client.api.events.typing).not.toHaveBeenCalled();
	});

	it("tells the thread you are typing, once for a burst of keystrokes", async () => {
		mount(conversationPage);
		const composer = await screen.findByLabelText(`Message ${linear.name}`);

		writeDraft(composer, "S");
		writeDraft(composer, "Se");
		writeDraft(composer, "Sen");

		await waitFor(() =>
			expect(client.api.events.typing).toHaveBeenCalledWith({
				params: { conversationId: chat.id },
			}),
		);
		expect(client.api.events.typing).toHaveBeenCalledTimes(1);
	});
});

describe("a collaboration open beside the thread", () => {
	const chatPage = conversationPage;
	const itemPage = `${chatPage}?item=${collaborationId}`;
	const collaboration = details(collaborationId, collaborationEntry.title, "collaboration", [
		collaborationRequest,
		collaborationAnswer,
	]);
	const incoming = (id: string, text: string): Message => ({
		...collaborationAnswer,
		id,
		status: "complete",
		parts: [{ type: "text", text }],
		content: text,
		createdAt: "2026-09-18T09:20:00.000Z",
	});

	/** Answers for the open collaboration; every other conversation keeps the thread's own answers. */
	function answerConversation(
		answer: (request: {
			params: { conversationId: string };
			query?: { cursor?: string };
		}) => Effect.Effect<unknown, unknown>,
	) {
		const others = client.api.conversations.get.getMockImplementation();
		client.api.conversations.get.mockImplementation(
			(request: { params: { conversationId: string } }) =>
				request.params.conversationId === collaborationId ? answer(request) : others?.(request),
		);
	}

	/** A stream for the open collaboration alone, so what it is sent is not also the thread's. */
	function conversationStream() {
		const updates = controlledEventStream();
		client.events.conversation.mockImplementation((conversationId: string) =>
			conversationId === collaborationId ? updates.stream : controlledEventStream().stream,
		);
		return updates;
	}

	const collaborationCalls = () =>
		client.api.conversations.get.mock.calls.filter(
			([request]) =>
				(request as { params: { conversationId: string } }).params.conversationId ===
				collaborationId,
		);

	it("says why a reply failed, in the provider's words", async () => {
		answerConversation(() =>
			Effect.succeed({
				...collaboration,
				messages: [
					collaborationRequest,
					{
						...collaborationAnswer,
						status: "failed",
						parts: [],
						content: "",
						error: "Provider returned 403: This model requires 18+ age confirmation.",
					},
				],
			}),
		);
		mount(itemPage);

		const panel = await screen.findByRole("complementary", { name: collaborationEntry.title });
		expect(await within(panel).findByText("Reply failed.")).toBeDefined();
		expect(within(panel).getByText(/18\+ age confirmation/)).toBeDefined();
	});

	it("says why a reply is not coming, until the collaboration moves on", async () => {
		const updates = conversationStream();
		answerConversation(() => Effect.succeed(collaboration));
		mount(itemPage);
		const panel = await screen.findByRole("complementary", { name: collaborationEntry.title });
		await within(panel).findByText(collaborationAnswer.content);

		updates.emit(
			streamEvent("conversation.notice", {
				conversationId: collaborationId,
				notice: "Helper has no model chosen, so it cannot reply.",
			}),
		);

		const notices = within(panel).getByRole("status", { name: "Conversation notices" });
		expect(
			await within(notices).findByText("Helper has no model chosen, so it cannot reply."),
		).toBeDefined();

		const messageId = "0199a3a0-0000-7000-8000-000000000102";
		updates.emit(
			streamEvent("message.created", {
				conversationId: collaborationId,
				message: incoming(messageId, "Trying again"),
			}),
		);
		await within(panel).findByText("Trying again");
		expect(within(notices).queryByText(/has no model chosen/)).toBeNull();
	});

	it("says when the collaboration could not be loaded", async () => {
		answerConversation(() => Effect.fail(new Forbidden({ message: userText`Unavailable` })));
		mount(itemPage);

		expect(await screen.findByText("Could not load this conversation")).toBeDefined();
	});

	it("applies streamed messages to the collaboration once each", async () => {
		const updates = conversationStream();
		answerConversation(() => Effect.succeed(collaboration));
		mount(itemPage);
		const panel = await screen.findByRole("complementary", { name: collaborationEntry.title });
		await within(panel).findByText(collaborationAnswer.content);

		const messageId = "0199a3a0-0000-7000-8000-000000000101";
		const created = streamEvent("message.created", {
			conversationId: collaborationId,
			message: { ...incoming(messageId, ""), status: "streaming", parts: [] },
		});
		updates.emit(created);
		updates.emit(created);
		updates.emit(
			streamEvent("message.delta", {
				conversationId: collaborationId,
				messageId,
				offset: 0,
				text: "Release checked",
			}),
		);
		updates.emit(
			streamEvent("message.completed", {
				conversationId: collaborationId,
				messageId,
				content: "Release checked",
				status: "complete",
			}),
		);

		expect(await within(panel).findByText("Release checked")).toBeDefined();
		expect(within(panel).getAllByText("Release checked")).toHaveLength(1);
	});

	it("loads and deduplicates older messages while keeping live updates", async () => {
		const updates = conversationStream();
		const cursor = "older-page";
		const earlier = { ...incoming("0199a3a0-0000-7000-8000-000000000102", "Earlier context") };
		earlier.createdAt = "2026-09-18T09:00:00.000Z";
		answerConversation((request) =>
			Effect.succeed(
				request.query?.cursor
					? {
							...collaboration,
							messages: [earlier, collaborationRequest],
							olderMessagesCursor: null,
						}
					: { ...collaboration, olderMessagesCursor: cursor },
			),
		);
		mount(itemPage);
		const panel = await screen.findByRole("complementary", { name: collaborationEntry.title });

		fireEvent.click(await within(panel).findByRole("button", { name: "Load older messages" }));

		expect(await within(panel).findByText("Earlier context")).toBeDefined();
		expect(within(panel).getAllByText(collaborationRequest.content)).toHaveLength(1);
		expect(client.api.conversations.get).toHaveBeenCalledWith({
			params: { conversationId: collaborationId },
			query: { cursor, limit: DEFAULT_CONVERSATION_HISTORY_LIMIT },
		});

		updates.emit(
			streamEvent("message.created", {
				conversationId: collaborationId,
				message: incoming("0199a3a0-0000-7000-8000-000000000103", "Live after paging"),
			}),
		);
		expect(await within(panel).findByText("Live after paging")).toBeDefined();
		expect(within(panel).getByText("Earlier context")).toBeDefined();
	});

	it("keeps current collaboration metadata and messages when an older page resolves late", async () => {
		const updates = conversationStream();
		const olderPage = pendingAnswer();
		answerConversation((request) =>
			request.query?.cursor
				? olderPage.effect
				: Effect.succeed({ ...collaboration, olderMessagesCursor: "older-page" }),
		);
		mount(itemPage);
		const panel = await screen.findByRole("complementary", { name: collaborationEntry.title });
		fireEvent.click(await within(panel).findByRole("button", { name: "Load older messages" }));

		updates.emit(
			streamEvent("message.completed", {
				conversationId: collaborationId,
				messageId: collaborationAnswer.id,
				status: "complete",
				content: "Completed while paging",
			}),
		);
		expect(await within(panel).findByText("Completed while paging")).toBeDefined();

		olderPage.answer(
			Effect.succeed({
				...collaboration,
				conversation: { ...collaboration.conversation, title: "Stale page title" },
				messages: [{ ...collaborationAnswer, content: "Stale page message" }],
				olderMessagesCursor: null,
			}),
		);

		await waitFor(() =>
			expect(within(panel).queryByRole("button", { name: "Load older messages" })).toBeNull(),
		);
		expect(within(panel).getByText("Completed while paging")).toBeDefined();
		expect(screen.queryByText("Stale page message")).toBeNull();
		expect(screen.queryByRole("complementary", { name: "Stale page title" })).toBeNull();
	});

	it("says when older messages could not be loaded, and lets you try again", async () => {
		answerConversation((request) =>
			request.query?.cursor
				? Effect.fail(new InternalServerError({ message: userText`History unavailable` }))
				: Effect.succeed({ ...collaboration, olderMessagesCursor: "older-page" }),
		);
		mount(itemPage);
		const panel = await screen.findByRole("complementary", { name: collaborationEntry.title });

		fireEvent.click(await within(panel).findByRole("button", { name: "Load older messages" }));

		expect((await within(panel).findByRole("alert")).textContent).toContain(
			"Earlier messages could not be loaded.",
		);
		expect(
			within(panel).getByRole("button", { name: "Load older messages" }).hasAttribute("disabled"),
		).toBe(false);
	});

	it("refetches when an event arrives before the collaboration has loaded", async () => {
		const updates = conversationStream();
		const initial = pendingAnswer();
		const early = incoming("0199a3a0-0000-7000-8000-000000000104", "Arrived early");
		let first = true;
		answerConversation(() => {
			if (first) {
				first = false;
				return initial.effect;
			}
			return Effect.succeed({ ...collaboration, messages: [...collaboration.messages, early] });
		});
		mount(itemPage);
		await waitFor(() => expect(client.events.conversation).toHaveBeenCalledWith(collaborationId));

		updates.emit(
			streamEvent("message.created", { conversationId: collaborationId, message: early }),
		);
		initial.answer(Effect.succeed(collaboration));

		expect(await screen.findByText("Arrived early")).toBeDefined();
		expect(collaborationCalls()).toHaveLength(2);
	});

	it("says the bot is typing from when its reply starts until it is finished", async () => {
		const updates = conversationStream();
		answerConversation(() =>
			Effect.succeed({
				...collaboration,
				conversation: { ...collaboration.conversation, status: "running" },
				messages: [collaborationRequest],
			}),
		);
		mount(itemPage);
		const panel = await screen.findByRole("complementary", { name: collaborationEntry.title });
		await within(panel).findByText(collaborationRequest.content);

		updates.emit(
			streamEvent("message.created", {
				conversationId: collaborationId,
				message: { ...collaborationAnswer, status: "streaming", content: "", parts: [] },
			}),
		);
		updates.emit(
			streamEvent("message.delta", {
				conversationId: collaborationId,
				messageId: collaborationAnswer.id,
				offset: 0,
				text: "Sam ",
			}),
		);
		// One line for the whole reply, and its words as they come.
		expect(
			await within(panel).findAllByRole("status", { name: `${triager.name} is typing` }),
		).toHaveLength(1);
		expect(within(panel).getByText("Sam")).toBeDefined();

		updates.emit(
			streamEvent("message.completed", {
				conversationId: collaborationId,
				messageId: collaborationAnswer.id,
				content: "Sam owns it.",
				status: "complete",
			}),
		);

		expect(await within(panel).findByText("Sam owns it.")).toBeDefined();
		expect(within(panel).queryByRole("status", { name: `${triager.name} is typing` })).toBeNull();
	});

	it("answers the call the collaboration waits on from its card", async () => {
		client.api.approvals.decide.mockReturnValue(Effect.undefined);
		const waitingCall = {
			type: "tool_call" as const,
			id: "0199a3a0-0000-7000-8000-000000000110",
			tool: "linear__create_issue",
			input: { title: "Checkout requests time out" },
			output: null,
			status: "awaiting_approval" as const,
			error: null,
			mutating: true,
			atOffset: 0,
			startedAt: "2026-09-18T09:12:00.000Z",
			finishedAt: null,
			approval: {
				status: "pending" as const,
				decidedByName: null,
				decidedAt: null,
			},
		};
		answerConversation(() =>
			Effect.succeed({
				...collaboration,
				capabilities: { ...collaboration.capabilities, approveToolCalls: true },
				messages: [
					collaborationRequest,
					{ ...collaborationAnswer, parts: [...collaborationAnswer.parts, waitingCall] },
				],
			}),
		);
		mount(itemPage);
		const panel = await screen.findByRole("complementary", { name: collaborationEntry.title });

		fireEvent.click(await within(panel).findByRole("button", { name: "Allow: Create issue" }));

		await waitFor(() =>
			expect(client.api.approvals.decide).toHaveBeenCalledWith({
				params: { toolCallId: waitingCall.id },
				payload: { decision: "allow_once" },
			}),
		);
	});

	it("closes the collaboration's stream when the sidebar closes", async () => {
		const updates = conversationStream();
		answerConversation(() => Effect.succeed(collaboration));
		mount(itemPage);
		const panel = await screen.findByRole("complementary", { name: collaborationEntry.title });
		await within(panel).findByText(collaborationAnswer.content);

		fireEvent.click(within(panel).getByRole("button", { name: "Close" }));

		await waitFor(() => expect(updates.close).toHaveBeenCalledOnce());
	});
});

describe("the thread's summary", () => {
	const chatPage = conversationPage;

	function answerChatActivity(activity: () => ConversationActivity) {
		client.api.conversations.activity.mockImplementation(() => Effect.sync(activity));
	}

	function summariserWithoutModel() {
		client.api.systemBots.list.mockReturnValue(
			Effect.succeed(
				builtInBots.map((bot) => (bot.key === "summarise" ? { ...bot, model: null } : bot)),
			),
		);
	}

	async function openDetails() {
		fireEvent.click(await screen.findByRole("button", { name: "Details" }));
		return screen.findByRole("complementary", { name: "Details" });
	}

	it("says the system bots have no model, and where to choose one", async () => {
		summariserWithoutModel();
		answerChatActivity(() => ({ ...chatActivity, summary: null }));
		mount(chatPage);
		const sidebar = await openDetails();

		expect(await within(sidebar).findByText(/The system bots write these/)).toBeDefined();
		expect(
			within(sidebar).getByRole("link", { name: "Choose their model" }).getAttribute("href"),
		).toBe("/suga/settings/providers/system");
	});

	it("tells a member why there is no summary without a link they cannot follow", async () => {
		apiAnswers({ role: "member" });
		chatAnswers();
		summariserWithoutModel();
		answerChatActivity(() => ({ ...chatActivity, summary: null }));
		mount(chatPage);
		const sidebar = await openDetails();

		expect(await within(sidebar).findByText(/The system bots write these/)).toBeDefined();
		expect(within(sidebar).queryByRole("link", { name: "Choose their model" })).toBeNull();
	});

	it("says nothing about choosing the system bots' model before the system bots have loaded", async () => {
		client.api.systemBots.list.mockReturnValue(Effect.never);
		answerChatActivity(() => ({ ...chatActivity, summary: null }));
		mount(chatPage);
		const sidebar = await openDetails();

		expect(
			await within(sidebar).findByText("A summary will appear after the first reply."),
		).toBeDefined();
		expect(within(sidebar).queryByRole("link", { name: "Choose their model" })).toBeNull();
	});

	it("shows a new summary once the thread says it changed", async () => {
		const updates = controlledEventStream();
		client.events.conversation.mockImplementation((conversationId: string) =>
			conversationId === chat.id ? updates.stream : controlledEventStream().stream,
		);
		let summarised = false;
		answerChatActivity(() => (summarised ? chatActivity : { ...chatActivity, summary: null }));
		mount(chatPage);
		const sidebar = await openDetails();
		expect(
			await within(sidebar).findByText("A summary will appear after the first reply."),
		).toBeDefined();

		summarised = true;
		updates.emit(streamEvent("conversation.changed", { conversationId: chat.id }));

		expect(await within(sidebar).findByText("Chat is complete.")).toBeDefined();
	});
});
