import {
	type ChatDetails,
	type ChatHistoryEntry,
	DEFAULT_CHAT_HISTORY_LIMIT,
	type Message,
	type ProjectChat,
	type Run,
	START_CHAT_TOOL,
	streamEvent,
} from "@sugabots/contracts";
import { Forbidden, InternalServerError, NotFound } from "@sugabots/contracts/http";
import { listedChat, testPerson } from "@sugabots/contracts/testing";
import { userText } from "@sugabots/errors";
import { cleanup, fireEvent, screen, waitFor, within } from "@testing-library/react";
import { Effect } from "effect";
import { afterEach, beforeEach, describe, expect, it, onTestFinished, vi } from "vitest";
import { createQueryClient } from "@/lib/query.ts";
import { workspacesQuery } from "@/lib/workspace.ts";
import {
	apiAnswers,
	bots,
	controlledEventStream,
	juno,
	linear,
	mount,
	pendingAnswer,
	projects,
	sam,
	triager,
	workspace,
	writeDraft,
} from "@/test-api.tsx";
import { client } from "@/test-client.ts";

vi.mock("@/api.ts", () => import("@/test-client.ts"));

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
const collaborationId = "0199a3a0-0000-7000-8000-0000000000e3";
const automationId = "0199a3a0-0000-7000-8000-0000000000e4";
const automationCollaborationId = "0199a3a0-0000-7000-8000-0000000000e7";
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
const person = testPerson({ id: sam.id, name: sam.name });
/** In the project, but has not written in any of its chats. */
const robin = testPerson({ id: "0199a3a0-0000-7000-8000-000000000501", name: "Robin Vale" });
const host = {
	kind: "bot" as const,
	id: linear.id,
	name: linear.name,
	handle: linear.handle,
	color: linear.color,
	eyes: linear.eyes,
	shape: linear.shape,
};
const collaborator = {
	kind: "bot" as const,
	id: triager.id,
	name: triager.name,
	handle: triager.handle,
	color: triager.color,
	eyes: triager.eyes,
	shape: triager.shape,
};
const mainMessage: Message = {
	id: "0199a3a0-0000-7000-8000-0000000000f1",
	chatId: chat.id,
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
	chatId: collaborationId,
	brief: "Check release ownership",
	status: "answered" as const,
	answer: "Sam owns the release.",
	atOffset: 19,
};
const botMessage: Message = {
	id: "0199a3a0-0000-7000-8000-0000000000f3",
	chatId: chat.id,
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
	chatId: collaborationId,
	author: host,
	parts: [{ type: "text", text: "Check release ownership" }],
	content: "Check release ownership",
	createdAt: "2026-09-18T09:11:00.000Z",
};
const collaborationAnswer: Message = {
	...mainMessage,
	id: "0199a3a0-0000-7000-8000-0000000000f5",
	chatId: collaborationId,
	author: collaborator,
	parts: [{ type: "text", text: "Sam owns the release." }],
	content: "Sam owns the release.",
	createdAt: "2026-09-18T09:12:00.000Z",
};
const automationMessage: Message = {
	...mainMessage,
	id: "0199a3a0-0000-7000-8000-0000000000f6",
	chatId: automationId,
	author: host,
	parts: [
		{ type: "text", text: "The overnight review completed." },
		{
			type: "collaboration",
			id: "0199a3a0-0000-7000-8000-0000000000f8",
			botId: triager.id,
			botName: triager.name,
			chatId: automationCollaborationId,
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
const collaborationEntry: ChatHistoryEntry = {
	chatId: collaborationId,
	parentChatId: chat.id,
	kind: "collaboration",
	title: "Check release ownership",
	participants: [host, collaborator],
	status: "completed",
	automationRun: null,
};
const automationEntry: ChatHistoryEntry = {
	chatId: automationId,
	parentChatId: null,
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
const automationCollaborationEntry: ChatHistoryEntry = {
	...collaborationEntry,
	chatId: automationCollaborationId,
	parentChatId: automationId,
	title: "Verify the overnight alerts",
};

function details(
	id: string,
	title: string,
	kind: ChatDetails["chat"]["kind"],
	messages: Message[],
): ChatDetails {
	return {
		chat: {
			id,
			workspaceId: linear.workspaceId,
			// As the server places it: a collaboration is in no project, the rest in the bot's default one.
			projectId: kind === "collaboration" ? null : linear.defaultProjectId,
			botId: kind === "collaboration" ? triager.id : linear.id,
			rootChatId: chat.id,
			kind,
			title,
			status: "done",
			parentChatId: kind === "collaboration" ? chat.id : null,
			resolvedAt: null,
			createdAt: "2026-09-18T08:00:00.000Z",
			updatedAt: "2026-09-18T09:22:00.000Z",
		},
		automationRun: kind === "run" ? automationRun : null,
		// The bot it asked for help has joined the chat, though it is not in the project.
		participants: kind === "collaboration" ? [host, collaborator] : [person, host, collaborator],
		// A bot's chats are its default project's, whose only bot is the bot itself.
		projectBots: [host],
		peopleReachingProject: [person, robin],
		messages,
		olderMessagesCursor: null,
		queuedSince: null,
		reads: [],
	};
}

/** Linear Handler's chats, with this one in them when `listed`. */
function chatList({ listed }: { listed: boolean }) {
	return Effect.succeed({
		chats: listed ? [listedChat(chat)] : [],
		automations: [],
	});
}

/**
 * Answers the chat's own details with `answer`, leaving every other
 * chat, such as an inline collaboration, to the usual answers.
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
			items: [collaborationEntry, automationEntry, automationCollaborationEntry],
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
							chatId: automationCollaborationId,
							content: "Verify the overnight alerts",
							parts: [{ type: "text", text: "Verify the overnight alerts" }],
						},
						{
							...collaborationAnswer,
							id: "0199a3a0-0000-7000-8000-0000000000fa",
							chatId: automationCollaborationId,
							content: "The alerts were verified.",
							parts: [{ type: "text", text: "The alerts were verified." }],
						},
					],
				);
				return Effect.succeed({
					...nested,
					chat: { ...nested.chat, parentChatId: automationId },
				});
			}
			default:
				return Effect.succeed(details(chat.id, "Chat", "project_chat", [mainMessage, botMessage]));
		}
	});
}

/** Goes to the chat's bot's settings, which unmounts the chat, and back to its composer. */
async function leaveAndReturn(router: ReturnType<typeof mount>["router"]): Promise<HTMLElement> {
	await router.navigate({ to: `/suga/bots/${linear.handle}/settings` });
	await waitFor(() => expect(screen.queryByLabelText(`Message ${linear.name}`)).toBeNull());
	await router.navigate({ to: chatPage });
	return await screen.findByLabelText(`Message ${linear.name}`);
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

describe("a bot's chat", () => {
	it("shows the chat's messages and inline collaborations", async () => {
		mount(chatPage);

		expect(await screen.findByText(mainMessage.content)).toBeDefined();
		expect(screen.getByText(botMessage.content)).toBeDefined();
		// A bot's chat shows a collaboration inline: what the two bots said, and a way to open it.
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

		expect(await screen.findByText(mainMessage.content)).toBeDefined();
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
		const messages = await screen.findByRole("log", { name: "Chat messages" });
		Object.defineProperty(messages, "scrollHeight", { configurable: true, value: 1_200 });
		messages.scrollTop = 100;
		const composer = await screen.findByLabelText(`Message ${linear.name}`);
		writeDraft(composer, "  Send the update  ");
		fireEvent.click(screen.getByRole("button", { name: "Send message" }));

		await waitFor(() =>
			expect(client.api.chats.send).toHaveBeenCalledWith({
				params: { chatId: chat.id },
				payload: { id: expect.any(String), message: "Send the update" },
			}),
		);
		await waitFor(() => expect(messages.scrollTop).toBe(1_200));
	});

	it("with other people in the chat, says the bot may let a draft mentioning just people pass", async () => {
		const shared = details(chat.id, "Chat", "project_chat", [mainMessage]);
		client.api.chats.get.mockReturnValue(
			Effect.succeed({ ...shared, participants: [...shared.participants, robin] }),
		);
		mount(chatPage);
		const composer = await screen.findByLabelText(`Message ${linear.name}`);
		expect(screen.queryByText(`${linear.name} will reply here.`)).toBeNull();

		writeDraft(composer, `@${robin.handle} can you check?`);

		expect(await screen.findByText(`${linear.name} may reply.`)).toBeTruthy();
		const box = screen.getByLabelText(`Message ${robin.name}`);
		// The finished mention is drawn in the box as the person's handle, as a sent message draws it.
		expect(within(box).getByText(`@${robin.handle}`)).toBeTruthy();

		writeDraft(box, `@${robin.handle} and @${linear.handle}, can you check?`);

		expect(await screen.findByText(`${linear.name} will reply here.`)).toBeTruthy();
		expect(screen.getByLabelText(`Message ${linear.name}`)).toBeTruthy();
	});

	it("offers the project's people and the bots here to mention, but not you", async () => {
		mount(chatPage);
		const composer = await screen.findByLabelText(`Message ${linear.name}`);
		writeDraft(composer, "@");

		const list = within(await screen.findByRole("listbox"));
		expect(list.getByRole("option", { name: new RegExp(linear.name) })).toBeTruthy();
		expect(list.getByRole("option", { name: new RegExp(robin.name) })).toBeTruthy();
		expect(list.getByRole("option", { name: new RegExp(triager.name) })).toBeTruthy();
		expect(list.queryByRole("option", { name: new RegExp(sam.name) })).toBeNull();
		// After the people and bots come the two groups, which are not people the project has.
		expect(list.getByRole("option", { name: /@here/ })).toBeTruthy();
		expect(list.getByRole("option", { name: /@channel/ })).toBeTruthy();
		expect(list.getAllByRole("option")).toHaveLength(5);
	});

	it("names the bot as the one who replies to a draft mentioning a bot outside its project", async () => {
		mount(chatPage);
		const composer = await screen.findByLabelText(`Message ${linear.name}`);
		expect(screen.queryByText(`${linear.name} will reply here.`)).toBeNull();

		writeDraft(composer, `@${triager.handle} can you check?`);

		// The floor ignores a bot outside the project; whether the bot asks it for help is the bot's choice.
		expect(screen.getByText(`${linear.name} will reply here.`)).toBeTruthy();
	});

	it("says the bot replied to will reply, though the reply mentions only people", async () => {
		const shared = details(chat.id, "Chat", "project_chat", [mainMessage, botMessage]);
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

		expect(await screen.findByLabelText(`Message ${robin.name}`)).toBeTruthy();
		expect(screen.getByText(`${linear.name} will reply here.`)).toBeTruthy();
		expect(screen.queryByText(`${linear.name} may reply.`)).toBeNull();
	});

	it("in an automation's feed, says its bot won't reply to a draft mentioning just people", async () => {
		client.api.chats.get.mockReturnValue(
			Effect.succeed({
				...details(chat.id, "Overnight review", "automation_feed", []),
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

		expect(await screen.findByText(`${linear.name} won't reply.`)).toBeTruthy();
	});

	it("offers no @here or @channel when nobody else could be notified", async () => {
		client.api.chats.get.mockReturnValue(
			Effect.succeed({
				...details(chat.id, "Chat", "project_chat", [mainMessage]),
				peopleReachingProject: [person],
			}),
		);
		mount(chatPage);
		const composer = await screen.findByLabelText(`Message ${linear.name}`);
		writeDraft(composer, "@");

		const list = within(await screen.findByRole("listbox"));
		expect(list.getByRole("option", { name: new RegExp(linear.name) })).toBeTruthy();
		expect(list.queryByRole("option", { name: /@here|@channel/ })).toBeNull();
	});

	it("holds a message for a bot with no model, saying where to choose one, but sends one for people only", async () => {
		client.api.bots.list.mockReturnValue(
			Effect.succeed(bots.map((one) => (one.id === linear.id ? { ...one, model: null } : one))),
		);
		client.api.chats.send.mockReturnValue(
			Effect.succeed({ message: mainMessage, routing: { status: "routed" } }),
		);
		mount(chatPage);

		expect(await screen.findByText(/has no model yet, so it cannot answer/)).toBeDefined();
		expect(screen.getByRole("link", { name: "Choose a model" }).getAttribute("href")).toBe(
			`/suga/bots/${linear.handle}/settings`,
		);
		const composer = screen.getByLabelText(`Message ${linear.name}`);
		writeDraft(composer, "Send the update");
		const send = screen.getByRole("button", { name: "Send message" }) as HTMLButtonElement;
		expect(send.disabled).toBe(true);
		expect(screen.queryByText(`${linear.name} will reply here.`)).toBeNull();

		// A message for people alone asks no bot to reply, so it goes.
		writeDraft(composer, `@${robin.handle} can you check?`);
		await waitFor(() => expect(screen.queryByText(/has no model yet/)).toBeNull());
		fireEvent.click(screen.getByRole("button", { name: "Send message" }));
		await waitFor(() => expect(client.api.chats.send).toHaveBeenCalled());
	});

	it("clears the composer while the message is still in flight", async () => {
		const posting = pendingAnswer();
		client.api.chats.send.mockReturnValue(posting.effect);
		mount(chatPage);
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
		mount(chatPage);
		const composer = await screen.findByLabelText(`Message ${linear.name}`);
		writeDraft(composer, "Send the update");
		fireEvent.click(screen.getByRole("button", { name: "Send message" }));

		await screen.findByText("Message not sent. Your draft is still here.");
		expect(composer.textContent).toBe("Send the update");
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

	it("keeps following the latest message while the bot works, and when it answers", async () => {
		const updates = controlledEventStream();
		client.events.chat.mockReturnValue(updates.stream);
		mount(chatPage);
		const messages = await screen.findByRole("log", { name: "Chat messages" });
		let scrollHeight = 1_200;
		Object.defineProperties(messages, {
			scrollHeight: { configurable: true, get: () => scrollHeight },
			clientHeight: { configurable: true, value: 400 },
		});
		messages.scrollTop = 800;
		fireEvent.scroll(messages);
		await waitFor(() => expect(client.events.chat).toHaveBeenCalledWith(chat.id));

		const writing = {
			...botMessage,
			id: "0199a3a0-0000-7000-8000-0000000000fb",
			status: "writing" as const,
			content: "Starting",
			parts: [{ type: "text" as const, text: "Starting" }],
			createdAt: "2026-09-18T09:20:00.000Z",
		};
		scrollHeight = 1_400;
		updates.emit(streamEvent("message.created", { chatId: chat.id, message: writing }));
		await screen.findByRole("status", { name: `${linear.name} is typing` });
		await waitFor(() => expect(messages.scrollTop).toBe(1_400));

		scrollHeight = 1_700;
		updates.emit(
			streamEvent("message.completed", {
				chatId: chat.id,
				messageId: writing.id,
				content: "Starting the response",
				status: "complete",
			}),
		);
		await screen.findByText("Starting the response");
		await waitFor(() => expect(messages.scrollTop).toBe(1_700));
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
		expect(await screen.findByRole("link", { name: "Download q3-report.csv" })).toBeDefined();

		updates.emit(
			streamEvent("message.delta", {
				chatId: chat.id,
				messageId: writing.id,
				offset: writing.content.length,
				text: ", with the totals.",
			}),
		);
		updates.emit(
			streamEvent("message.completed", {
				chatId: chat.id,
				messageId: writing.id,
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
			Effect.succeed(details(chat.id, "Chat", "project_chat", [mainMessage, reply]));
		answerChatWith(() => chatWithReply(writing));
		const { router } = mount(chatPage);
		await screen.findByRole("status", { name: `${linear.name} is typing` });

		answerChatWith(() => chatWithReply(answered));
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
		mount(chatPage);
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
			author: testPerson({ id: "0199a3a0-0000-7000-8000-0000000000fe", name: "Jay Park" }),
			content: "Is the Stripe webhook part of it?",
			parts: [{ type: "text", text: "Is the Stripe webhook part of it?" }],
			createdAt: "2026-09-18T09:21:00.000Z",
		};
		/** The chat as the server has it, with `queuedSince` when a turn started waiting. */
		const serverHas = (queuedSince: string | null) =>
			client.api.chats.get.mockReturnValue(
				Effect.succeed({
					...details(chat.id, "Chat", "project_chat", [mainMessage, writing, followUp]),
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
			updates.emit(
				streamEvent("turn.started", {
					chatId: chat.id,
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
		const waiting = {
			...botMessage,
			status: "writing" as const,
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
		answerChatWith(() =>
			Effect.succeed(details(chat.id, "Chat", "project_chat", [mainMessage, waiting])),
		);
		mount(chatPage);

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
		const { router } = mount(chatPage);
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
		await waitFor(() => expect(router.state.location.search.nestedChat).toBe(collaborationId));
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
			mount(chatPage);
			fireEvent.click(
				await screen.findByRole("button", {
					name: new RegExp(`^Open Collaboration: ${linear.name} .*${triager.name}`),
				}),
			);

			const timeline = await screen.findByRole("log", { name: "Collaboration messages" });
			expect(timeline.scrollTop).toBe(0);
		} finally {
			if (originalScrollHeight) {
				Object.defineProperty(HTMLElement.prototype, "scrollHeight", originalScrollHeight);
			} else {
				Reflect.deleteProperty(HTMLElement.prototype, "scrollHeight");
			}
		}
	});

	it("never opens an automation run beside the chat, even from the nestedChat query", async () => {
		mount(`${chatPage}?nestedChat=${automationId}`);

		await screen.findByText(mainMessage.content);
		expect(screen.queryByRole("complementary", { name: automationEntry.title })).toBeNull();
	});

	it("offers no way back to a run from its collaboration beside the chat", async () => {
		mount(`${chatPage}?nestedChat=${automationCollaborationId}`);

		const collaborationPanel = await screen.findByRole("complementary", {
			name: automationCollaborationEntry.title,
		});
		expect(
			within(collaborationPanel).queryByRole("button", { name: "Back to automation" }),
		).toBeNull();
	});

	it("opens with whom the chat is with, when there is nothing older", async () => {
		client.api.chats.messages.mockReturnValue(Effect.succeed({ items: [], nextCursor: null }));
		client.api.chats.get.mockReturnValue(
			Effect.succeed(details(chat.id, "Chat", "project_chat", [])),
		);
		mount(chatPage);

		expect(await screen.findByRole("heading", { name: "Chat", level: 2 })).toBeDefined();
		expect(screen.getByText(`With ${linear.name}`)).toBeDefined();
	});

	it("opens Details from the chat's name, and leads back to its bot", async () => {
		mount(chatPage);

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
		const { router } = mount(chatPage);

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
	 * The way back to the chat a settings page was opened from: the Back above
	 * the page on a phone. Wide, the trail and the sidebar go back instead, so
	 * the bar is hidden there by style, which the test DOM does not apply.
	 */
	async function backToChat() {
		const [back] = await within(await screen.findByRole("main")).findAllByRole("link", {
			name: "Chat",
		});
		if (!back) throw new Error("No way back to the chat");
		return back;
	}

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

	it("leads from a person's name to their page under People, and back to the chat", async () => {
		answerMessagesWith({
			...mainMessage,
			id: "0199a3a0-0000-7000-8000-0000000000fa",
			author: testPerson({ id: juno.id, name: juno.name }),
			createdAt: "2026-09-18T09:15:00.000Z",
		});
		const { router } = mount(chatPage);
		const messages = await screen.findByRole("log", { name: "Chat messages" });

		fireEvent.click(await within(messages).findByRole("link", { name: juno.name }));
		await waitFor(() =>
			expect(router.state.location.pathname).toBe(
				"/suga/settings/people/0199a3a0-0000-7000-8000-0000000000d2",
			),
		);
		fireEvent.click(await backToChat());

		await waitFor(() => expect(router.state.location.pathname).toBe(chatPage));
	});

	it("leads from a bot's name to its settings, and back to the chat", async () => {
		answerMessagesWith({
			...mainMessage,
			id: "0199a3a0-0000-7000-8000-0000000000fa",
			author: collaborator,
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

	it("lists the people in a chat with more than one in it from its header, the viewer as you", async () => {
		const shared = details(chat.id, "Chat", "project_chat", [mainMessage]);
		client.api.chats.get.mockReturnValue(
			Effect.succeed({ ...shared, participants: [...shared.participants, robin] }),
		);
		mount(chatPage);

		fireEvent.click(await screen.findByRole("button", { name: "2 people in this chat" }));

		const people = await screen.findByRole("menu");
		const [first, second, ...rest] = within(people).getAllByRole("menuitem");
		expect(first?.textContent).toContain("(you)");
		expect(second?.textContent).toContain(robin.name);
		expect(rest).toEqual([]);
	});

	it("closes a direct-linked collaboration without leaving the chat", async () => {
		const { router } = mount(`${chatPage}?nestedChat=${collaborationId}`);
		const panel = await screen.findByRole("complementary", { name: collaborationEntry.title });
		expect(within(panel).getByRole("heading", { name: "Collaboration" })).toBeDefined();
		fireEvent.click(within(panel).getByRole("button", { name: "Close" }));

		await waitFor(() =>
			expect(screen.queryByRole("complementary", { name: collaborationEntry.title })).toBeNull(),
		);
		expect(router.state.location.pathname).toBe(chatPage);
	});

	it("opens a chat the bot started with a bot outside its project at that bot's address", async () => {
		const startedId = "0199a3a0-0000-7000-8000-0000000002a1";
		const startedChat = details(startedId, "Release checklist", "project_chat", []);
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
					writeOrDelete: true,
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

		expect(
			await screen.findByRole("heading", { name: automationRun.automationName }),
		).toBeDefined();
		expect(screen.queryByRole("log", { name: "Chat messages" })).toBeNull();
		expect(screen.getByRole("link", { name: `Back to ${linear.name}` })).toBeDefined();
		expect(screen.getByRole("link", { name: "Open chat" }).getAttribute("href")).toBe(chatPage);
	});

	it("says so when the message cannot be found in the chat", async () => {
		mount(opened("0199a3a0-0000-7000-8000-000000000299"));

		expect(
			await screen.findByText("Could not find the message you opened in this chat."),
		).toBeDefined();
	});

	it("shows a collaboration in a project's chat as the page at the chat's address, and beside that chat", async () => {
		const project = projects[1] as (typeof projects)[number];
		const projectChat = {
			kind: "project_chat" as const,
			id: chat.id,
			workspaceId: chat.workspaceId,
			title: project.name,
			createdAt: chat.createdAt,
			updatedAt: chat.updatedAt,
			projectId: project.id,
			botId: null,
			resolvedAt: null,
		};
		client.api.chats.projectChats.mockReturnValue(
			Effect.succeed({ chats: [listedChat(projectChat)], automations: [] }),
		);
		const collaboration = details(collaborationId, collaborationEntry.title, "collaboration", [
			collaborationRequest,
			collaborationAnswer,
		]);
		const inProject = (one: ChatDetails): ChatDetails => ({
			...one,
			chat: { ...one.chat, projectId: project.id },
		});
		const chatDetails = details(chat.id, project.name, "project_chat", [mainMessage]);
		client.api.chats.get.mockImplementation(({ params }: { params: { chatId: string } }) =>
			Effect.succeed(
				params.chatId === collaborationId
					? inProject(collaboration)
					: inProject({
							...chatDetails,
							chat: { ...chatDetails.chat, botId: null },
						}),
			),
		);
		const projectPage = `/suga/projects/${project.slug}/${chat.id}`;

		mount(`${projectPage}?nestedChatPage=${collaborationId}`);
		expect(await screen.findByRole("heading", { name: "Collaboration" })).toBeDefined();
		expect(screen.queryByRole("log", { name: "Chat messages" })).toBeNull();
		expect(screen.getByRole("link", { name: "Open chat" }).getAttribute("href")).toBe(projectPage);
		cleanup();

		// Asked to open beside that chat, as Approvals does, it opens there.
		mount(`${projectPage}?nestedChat=${collaborationId}`);
		expect(await screen.findByRole("log", { name: "Chat messages" })).toBeDefined();
		expect(
			await screen.findByRole("complementary", { name: collaborationEntry.title }),
		).toBeDefined();
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

		expect(await screen.findByText(mainMessage.content)).toBeDefined();
		expect(screen.queryByText("Could not find the message you opened in this chat.")).toBeNull();
	});
});

describe("people typing in the chat", () => {
	const junoInChat = testPerson({ id: juno.id, name: juno.name });
	const junoTyping = streamEvent("person.typing", {
		chatId: chat.id,
		person: junoInChat,
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

		await vi.advanceTimersByTimeAsync(7_000);
		await waitFor(() =>
			expect(screen.queryByRole("status", { name: "Juno is typing" })).toBeNull(),
		);
	});

	it("does not show you your own typing", async () => {
		const updates = await watchChat();

		updates.emit(streamEvent("person.typing", { chatId: chat.id, person }));
		updates.emit(junoTyping);

		await screen.findByRole("status", { name: "Juno is typing" });
		expect(screen.queryByRole("status", { name: /Sam/ })).toBeNull();
	});

	it("does not say you are typing just because a draft was kept from before", async () => {
		const { router } = mount(chatPage);
		writeDraft(await screen.findByLabelText(`Message ${linear.name}`), "Half a thought");
		await waitFor(() => expect(client.api.events.typing).toHaveBeenCalledTimes(1));
		client.api.events.typing.mockClear();
		client.events.chat.mockClear();

		await leaveAndReturn(router);
		await waitFor(() => expect(client.events.chat).toHaveBeenCalledWith(chat.id));
		expect(client.api.events.typing).not.toHaveBeenCalled();
	});

	it("tells the chat you are typing, once for a burst of keystrokes", async () => {
		mount(chatPage);
		const composer = await screen.findByLabelText(`Message ${linear.name}`);

		writeDraft(composer, "S");
		writeDraft(composer, "Se");
		writeDraft(composer, "Sen");

		await waitFor(() =>
			expect(client.api.events.typing).toHaveBeenCalledWith({
				params: { chatId: chat.id },
			}),
		);
		expect(client.api.events.typing).toHaveBeenCalledTimes(1);
	});
});

describe("a collaboration open beside the chat", () => {
	const nestedChatPage = `${chatPage}?nestedChat=${collaborationId}`;
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

	/** Answers for the open collaboration; every other chat keeps the chat's own answers. */
	function answerChat(
		answer: (request: {
			params: { chatId: string };
			query?: { cursor?: string };
		}) => Effect.Effect<unknown, unknown>,
	) {
		const others = client.api.chats.get.getMockImplementation();
		client.api.chats.get.mockImplementation((request: { params: { chatId: string } }) =>
			request.params.chatId === collaborationId ? answer(request) : others?.(request),
		);
	}

	/** A stream for the open collaboration alone, so what it is sent is not also the chat's. */
	function chatStream() {
		const updates = controlledEventStream();
		client.events.chat.mockImplementation((chatId: string) =>
			chatId === collaborationId ? updates.stream : controlledEventStream().stream,
		);
		return updates;
	}

	const collaborationCalls = () =>
		client.api.chats.get.mock.calls.filter(
			([request]) => (request as { params: { chatId: string } }).params.chatId === collaborationId,
		);

	it("says why a reply failed, in the provider's words", async () => {
		answerChat(() =>
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
		mount(nestedChatPage);

		const panel = await screen.findByRole("complementary", { name: collaborationEntry.title });
		expect(await within(panel).findByText("Reply failed.")).toBeDefined();
		expect(within(panel).getByText(/18\+ age confirmation/)).toBeDefined();
	});

	it("says why a reply is not coming, until the collaboration moves on", async () => {
		const updates = chatStream();
		answerChat(() => Effect.succeed(collaboration));
		mount(nestedChatPage);
		const panel = await screen.findByRole("complementary", { name: collaborationEntry.title });
		await within(panel).findByText(collaborationAnswer.content);

		updates.emit(
			streamEvent("chat.notice", {
				chatId: collaborationId,
				notice: "Helper has no model chosen, so it cannot reply.",
			}),
		);

		const notices = within(panel).getByRole("status", { name: "Chat notices" });
		expect(
			await within(notices).findByText("Helper has no model chosen, so it cannot reply."),
		).toBeDefined();

		const messageId = "0199a3a0-0000-7000-8000-000000000102";
		updates.emit(
			streamEvent("message.created", {
				chatId: collaborationId,
				message: incoming(messageId, "Trying again"),
			}),
		);
		await within(panel).findByText("Trying again");
		expect(within(notices).queryByText(/has no model chosen/)).toBeNull();
	});

	it("is not a chat of the bot asked, at that bot's chat address", async () => {
		answerChat(() => Effect.succeed(collaboration));
		mount(`/suga/bots/${triager.handle}/chats/${collaborationId}`);

		expect(await screen.findByText("Chat not found")).toBeDefined();
	});

	it("says when the collaboration could not be loaded", async () => {
		answerChat(() => Effect.fail(new Forbidden({ message: userText`Unavailable` })));
		mount(nestedChatPage);

		expect(await screen.findByText("Could not load this chat")).toBeDefined();
	});

	it("applies streamed messages to the collaboration once each", async () => {
		const updates = chatStream();
		answerChat(() => Effect.succeed(collaboration));
		mount(nestedChatPage);
		const panel = await screen.findByRole("complementary", { name: collaborationEntry.title });
		await within(panel).findByText(collaborationAnswer.content);

		const messageId = "0199a3a0-0000-7000-8000-000000000101";
		const created = streamEvent("message.created", {
			chatId: collaborationId,
			message: { ...incoming(messageId, ""), status: "writing", parts: [] },
		});
		updates.emit(created);
		updates.emit(created);
		updates.emit(
			streamEvent("message.delta", {
				chatId: collaborationId,
				messageId,
				offset: 0,
				text: "Release checked",
			}),
		);
		updates.emit(
			streamEvent("message.completed", {
				chatId: collaborationId,
				messageId,
				content: "Release checked",
				status: "complete",
			}),
		);

		expect(await within(panel).findByText("Release checked")).toBeDefined();
		expect(within(panel).getAllByText("Release checked")).toHaveLength(1);
	});

	it("loads and deduplicates older messages while keeping live updates", async () => {
		const updates = chatStream();
		const cursor = "older-page";
		const earlier = { ...incoming("0199a3a0-0000-7000-8000-000000000102", "Earlier context") };
		earlier.createdAt = "2026-09-18T09:00:00.000Z";
		answerChat((request) =>
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
		mount(nestedChatPage);
		const panel = await screen.findByRole("complementary", { name: collaborationEntry.title });

		fireEvent.click(await within(panel).findByRole("button", { name: "Load older messages" }));

		expect(await within(panel).findByText("Earlier context")).toBeDefined();
		expect(within(panel).getAllByText(collaborationRequest.content)).toHaveLength(1);
		expect(client.api.chats.get).toHaveBeenCalledWith({
			params: { chatId: collaborationId },
			query: { cursor, limit: DEFAULT_CHAT_HISTORY_LIMIT },
		});

		updates.emit(
			streamEvent("message.created", {
				chatId: collaborationId,
				message: incoming("0199a3a0-0000-7000-8000-000000000103", "Live after paging"),
			}),
		);
		expect(await within(panel).findByText("Live after paging")).toBeDefined();
		expect(within(panel).getByText("Earlier context")).toBeDefined();
	});

	it("keeps current collaboration metadata and messages when an older page resolves late", async () => {
		const updates = chatStream();
		const olderPage = pendingAnswer();
		answerChat((request) =>
			request.query?.cursor
				? olderPage.effect
				: Effect.succeed({ ...collaboration, olderMessagesCursor: "older-page" }),
		);
		mount(nestedChatPage);
		const panel = await screen.findByRole("complementary", { name: collaborationEntry.title });
		fireEvent.click(await within(panel).findByRole("button", { name: "Load older messages" }));

		updates.emit(
			streamEvent("message.completed", {
				chatId: collaborationId,
				messageId: collaborationAnswer.id,
				status: "complete",
				content: "Completed while paging",
			}),
		);
		expect(await within(panel).findByText("Completed while paging")).toBeDefined();

		olderPage.answer(
			Effect.succeed({
				...collaboration,
				chat: { ...collaboration.chat, title: "Stale page title" },
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
		answerChat((request) =>
			request.query?.cursor
				? Effect.fail(new InternalServerError({ message: userText`History unavailable` }))
				: Effect.succeed({ ...collaboration, olderMessagesCursor: "older-page" }),
		);
		mount(nestedChatPage);
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
		const updates = chatStream();
		const initial = pendingAnswer();
		const early = incoming("0199a3a0-0000-7000-8000-000000000104", "Arrived early");
		let first = true;
		answerChat(() => {
			if (first) {
				first = false;
				return initial.effect;
			}
			return Effect.succeed({ ...collaboration, messages: [...collaboration.messages, early] });
		});
		mount(nestedChatPage);
		await waitFor(() => expect(client.events.chat).toHaveBeenCalledWith(collaborationId));

		updates.emit(streamEvent("message.created", { chatId: collaborationId, message: early }));
		initial.answer(Effect.succeed(collaboration));

		expect(await screen.findByText("Arrived early")).toBeDefined();
		expect(collaborationCalls()).toHaveLength(2);
	});

	it("says the bot is typing from when its reply starts until it is finished", async () => {
		const updates = chatStream();
		answerChat(() =>
			Effect.succeed({
				...collaboration,
				chat: { ...collaboration.chat, status: "running" },
				messages: [collaborationRequest],
			}),
		);
		mount(nestedChatPage);
		const panel = await screen.findByRole("complementary", { name: collaborationEntry.title });
		await within(panel).findByText(collaborationRequest.content);

		updates.emit(
			streamEvent("message.created", {
				chatId: collaborationId,
				message: { ...collaborationAnswer, status: "writing", content: "", parts: [] },
			}),
		);
		updates.emit(
			streamEvent("message.delta", {
				chatId: collaborationId,
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
				chatId: collaborationId,
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
			writeOrDelete: true,
			atOffset: 0,
			startedAt: "2026-09-18T09:12:00.000Z",
			finishedAt: null,
			approval: {
				status: "pending" as const,
				decidedByName: null,
				decidedAt: null,
			},
		};
		answerChat(() =>
			Effect.succeed({
				...collaboration,
				capabilities: { ...collaboration.capabilities, approveToolCalls: true },
				messages: [
					collaborationRequest,
					{ ...collaborationAnswer, parts: [...collaborationAnswer.parts, waitingCall] },
				],
			}),
		);
		mount(nestedChatPage);
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
		const updates = chatStream();
		answerChat(() => Effect.succeed(collaboration));
		mount(nestedChatPage);
		const panel = await screen.findByRole("complementary", { name: collaborationEntry.title });
		await within(panel).findByText(collaborationAnswer.content);

		fireEvent.click(within(panel).getByRole("button", { name: "Close" }));

		await waitFor(() => expect(updates.close).toHaveBeenCalledOnce());
	});
});
