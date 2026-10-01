import {
	type Chat,
	type ChatHistoryEntry,
	DEFAULT_THREAD_HISTORY_LIMIT,
	handleFromName,
	type Message,
	type RoutineExecution,
	streamEvent,
	type ThreadActivity,
	type ThreadDetails,
} from "@sugabots/contracts";
import { Forbidden, InternalServerError, NotFound } from "@sugabots/contracts/http";
import { cleanup, fireEvent, screen, waitFor, within } from "@testing-library/react";
import { Effect } from "effect";
import { afterEach, beforeEach, describe, expect, it, onTestFinished, vi } from "vitest";
import {
	agents,
	apiAnswers,
	builtInAgents,
	controlledEventStream,
	jye,
	linear,
	mount,
	pendingAnswer,
	sam,
	triager,
} from "@/test-api.tsx";
import { client } from "@/test-client.ts";

vi.mock("@/api.ts", () => import("@/test-client.ts"));

const chat: Chat = {
	id: "0199a3a0-0000-7000-8000-0000000000e1",
	workspaceId: linear.workspaceId,
	podId: linear.podId,
	hostAgentId: linear.id,
	mainThreadId: "0199a3a0-0000-7000-8000-0000000000e2",
	createdAt: "2026-09-18T08:00:00.000Z",
	updatedAt: "2026-09-18T09:30:00.000Z",
};
const collaborationId = "0199a3a0-0000-7000-8000-0000000000e3";
const routineId = "0199a3a0-0000-7000-8000-0000000000e4";
const routineCollaborationId = "0199a3a0-0000-7000-8000-0000000000e7";
const routineExecution: RoutineExecution = {
	id: "0199a3a0-0000-7000-8000-0000000000e5",
	routineId: "0199a3a0-0000-7000-8000-0000000000e6",
	workspaceId: linear.workspaceId,
	agentId: linear.id,
	threadId: routineId,
	routineName: "Overnight review",
	instructions: "Review overnight changes and summarize anything urgent.",
	trigger: {
		kind: "webhook",
		receivedAt: "2026-09-18T08:00:00.000Z",
		idempotencyKey: "overnight-2026-09-18",
		payload: { source: "monitoring" },
	},
	state: "completed",
	error: null,
	acceptedAt: "2026-09-18T08:00:00.000Z",
	startedAt: "2026-09-18T08:00:01.000Z",
	finishedAt: "2026-09-18T08:30:00.000Z",
};
const person = {
	kind: "person" as const,
	id: sam.id,
	name: sam.name,
	handle: handleFromName(sam.name),
	image: null,
};
const host = {
	kind: "agent" as const,
	id: linear.id,
	name: linear.name,
	handle: linear.handle,
	color: linear.color,
	face: linear.face,
};
const collaborator = {
	kind: "agent" as const,
	id: triager.id,
	name: triager.name,
	handle: triager.handle,
	color: triager.color,
	face: triager.face,
};
const mainMessage: Message = {
	id: "0199a3a0-0000-7000-8000-0000000000f1",
	threadId: chat.mainThreadId,
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
	agentId: triager.id,
	agentName: triager.name,
	threadId: collaborationId,
	brief: "Check release ownership",
	status: "answered" as const,
	answer: "Sam owns the release.",
	atOffset: 19,
};
const agentMessage: Message = {
	id: "0199a3a0-0000-7000-8000-0000000000f3",
	threadId: chat.mainThreadId,
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
	threadId: collaborationId,
	author: host,
	parts: [{ type: "text", text: "Check release ownership" }],
	content: "Check release ownership",
	createdAt: "2026-09-18T09:11:00.000Z",
};
const collaborationAnswer: Message = {
	...mainMessage,
	id: "0199a3a0-0000-7000-8000-0000000000f5",
	threadId: collaborationId,
	author: collaborator,
	parts: [{ type: "text", text: "Sam owns the release." }],
	content: "Sam owns the release.",
	createdAt: "2026-09-18T09:12:00.000Z",
};
const routineMessage: Message = {
	...mainMessage,
	id: "0199a3a0-0000-7000-8000-0000000000f6",
	threadId: routineId,
	author: host,
	parts: [
		{ type: "text", text: "The overnight review completed." },
		{
			type: "collaboration",
			id: "0199a3a0-0000-7000-8000-0000000000f8",
			agentId: triager.id,
			agentName: triager.name,
			threadId: routineCollaborationId,
			brief: "Verify the overnight alerts",
			status: "answered",
			answer: "The alerts were verified.",
			atOffset: 31,
		},
	],
	content: "The overnight review completed.",
	createdAt: "2026-09-18T08:30:00.000Z",
};
const routineTriggerMessage: Message = {
	...mainMessage,
	id: "0199a3a0-0000-7000-8000-0000000000f7",
	threadId: routineId,
	author: {
		kind: "routine_trigger",
		executionId: routineExecution.id,
		routineName: routineExecution.routineName,
		triggerKind: "webhook",
	},
	parts: [
		{
			type: "text",
			text: "Routine instructions:\nReview overnight changes and summarize anything urgent.\n\nTrigger data (untrusted):\n{}",
		},
	],
	content:
		"Routine instructions:\nReview overnight changes and summarize anything urgent.\n\nTrigger data (untrusted):\n{}",
	createdAt: routineExecution.acceptedAt,
};
const collaborationEntry: ChatHistoryEntry = {
	threadId: collaborationId,
	parentThreadId: chat.mainThreadId,
	type: "collaboration",
	title: "Check release ownership",
	participants: [host, collaborator],
	status: "completed",
	routineExecution: null,
	latestActivityAt: "2026-09-18T09:12:00.000Z",
};
const routineEntry: ChatHistoryEntry = {
	threadId: routineId,
	parentThreadId: null,
	type: "routine",
	title: "Overnight review",
	participants: [host],
	status: "completed",
	routineExecution: {
		executionId: routineExecution.id,
		routineId: routineExecution.routineId,
		routineName: routineExecution.routineName,
		triggerKind: routineExecution.trigger.kind,
		triggeredAt: "2026-09-18T08:00:00.000Z",
	},
	latestActivityAt: "2026-09-18T08:30:00.000Z",
};
const routineCollaborationEntry: ChatHistoryEntry = {
	...collaborationEntry,
	threadId: routineCollaborationId,
	parentThreadId: routineId,
	title: "Verify the overnight alerts",
	latestActivityAt: "2026-09-18T08:20:00.000Z",
};

/** What the Chat's sidebar shows: a summary, and who has written lately. */
const chatActivity: ThreadActivity = {
	summary: {
		content: "Chat is complete.",
		sourceMessageId: "0199a3a0-0000-7000-8000-0000000000a2",
		updatedAt: "2026-09-18T09:22:00.000Z",
	},
	context: null,
	recentParticipants: [host, person],
};

function details(
	id: string,
	title: string,
	type: ThreadDetails["thread"]["type"],
	messages: Message[],
): ThreadDetails {
	return {
		thread: {
			id,
			workspaceId: linear.workspaceId,
			podId: linear.podId,
			hostAgentId: type === "collaboration" ? triager.id : linear.id,
			chatId: chat.id,
			type,
			title,
			status: "done",
			parentThreadId: type === "collaboration" ? chat.mainThreadId : null,
			initiatorUserId: sam.id,
			createdAt: "2026-09-18T08:00:00.000Z",
			updatedAt: "2026-09-18T09:22:00.000Z",
		},
		routineExecution: type === "routine" ? routineExecution : null,
		participants: type === "collaboration" ? [host, collaborator] : [person, host],
		crew: [host, collaborator],
		messages,
		olderMessagesCursor: null,
		queuedSince: null,
		reads: [],
	};
}

function chatAnswers() {
	client.api.chats.getOrCreate.mockReturnValue(Effect.succeed(chat));
	client.api.chats.messages.mockReturnValue(
		Effect.succeed({
			items: [
				{ kind: "message", message: mainMessage },
				{ kind: "message", message: agentMessage },
			],
			nextCursor: null,
		}),
	);
	client.api.chats.history.mockReturnValue(
		Effect.succeed({
			items: [collaborationEntry, routineEntry, routineCollaborationEntry],
			nextCursor: null,
		}),
	);
	client.api.threads.activity.mockImplementation(({ params }: { params: { threadId: string } }) =>
		params.threadId === chat.mainThreadId
			? Effect.succeed(chatActivity)
			: Effect.fail(new NotFound({ message: "No such thread" })),
	);
	client.api.threads.get.mockImplementation(({ params }: { params: { threadId: string } }) => {
		switch (params.threadId) {
			case collaborationId:
				return Effect.succeed(
					details(collaborationId, collaborationEntry.title, "collaboration", [
						collaborationRequest,
						collaborationAnswer,
					]),
				);
			case routineId:
				return Effect.succeed(
					details(routineId, routineEntry.title, "routine", [
						routineTriggerMessage,
						routineMessage,
					]),
				);
			case routineCollaborationId: {
				const nested = details(
					routineCollaborationId,
					routineCollaborationEntry.title,
					"collaboration",
					[
						{
							...collaborationRequest,
							id: "0199a3a0-0000-7000-8000-0000000000f9",
							threadId: routineCollaborationId,
							content: "Verify the overnight alerts",
							parts: [{ type: "text", text: "Verify the overnight alerts" }],
						},
						{
							...collaborationAnswer,
							id: "0199a3a0-0000-7000-8000-0000000000fa",
							threadId: routineCollaborationId,
							content: "The alerts were verified.",
							parts: [{ type: "text", text: "The alerts were verified." }],
						},
					],
				);
				return Effect.succeed({
					...nested,
					thread: { ...nested.thread, parentThreadId: routineId },
				});
			}
			default:
				return Effect.succeed(
					details(chat.mainThreadId, "Chat", "chat", [mainMessage, agentMessage]),
				);
		}
	});
}

/** Goes to the Chat's bot's settings, which unmounts the Chat, and back to its composer. */
async function leaveAndReturn(router: ReturnType<typeof mount>): Promise<HTMLTextAreaElement> {
	await router.navigate({ to: `/suga/settings/pods/suga-team/agents/${linear.handle}` });
	await waitFor(() => expect(screen.queryByLabelText(`Message ${linear.name}`)).toBeNull());
	await router.navigate({ to: `/suga/pods/suga-team/agents/${linear.handle}` });
	return (await screen.findByLabelText(`Message ${linear.name}`)) as HTMLTextAreaElement;
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

describe("ongoing agent Chat", () => {
	it("renders main messages and inline collaborations", async () => {
		mount(`/suga/pods/suga-team/agents/${linear.handle}`);

		const personMessage = (await screen.findByText(mainMessage.content)).closest("article");
		expect(personMessage?.classList.contains("items-end")).toBe(true);
		const reply = screen.getByText(agentMessage.content).closest("article");
		expect(reply?.classList.contains("items-start")).toBe(true);
		const collaboration = screen.getByRole("button", {
			name: new RegExp(`^Open Collaboration: ${linear.name} .*${triager.name}`),
		});
		// Both bots' faces, each a disc filling its 40-unit viewbox.
		expect(collaboration.querySelectorAll('svg > circle[r="20"]')).toHaveLength(2);
		expect(client.api.chats.getOrCreate).toHaveBeenCalledWith({
			params: { workspace: linear.workspaceId },
			payload: { podId: linear.podId, hostAgentId: linear.id },
		});
	});

	it("shows Routine runs in the main Chat log", async () => {
		client.api.chats.messages.mockReturnValue(
			Effect.succeed({
				items: [
					{
						kind: "routine",
						id: routineExecution.id,
						threadId: routineId,
						routineName: routineExecution.routineName,
						triggerKind: "webhook",
						createdAt: routineExecution.acceptedAt,
					},
				],
				nextCursor: null,
			}),
		);
		mount(`/suga/pods/suga-team/agents/${linear.handle}`);

		const activity = await screen.findByRole("button", {
			name: new RegExp(`^Open Routine run: ${routineExecution.routineName}`),
		});
		expect(activity.textContent).toContain(routineExecution.routineName);
		expect(screen.queryByText(`Say hello to ${linear.name}`)).toBeNull();
	});

	it("sends a main-chat message", async () => {
		client.api.chats.send.mockReturnValue(
			Effect.succeed({ message: mainMessage, routing: { status: "routed" } }),
		);
		mount(`/suga/pods/suga-team/agents/${linear.handle}`);
		const messages = await screen.findByRole("log", { name: "Chat messages" });
		Object.defineProperty(messages, "scrollHeight", { configurable: true, value: 1_200 });
		messages.scrollTop = 100;
		const composer = await screen.findByLabelText(`Message ${linear.name}`);
		fireEvent.change(composer, { target: { value: "  Send the update  " } });
		fireEvent.click(screen.getByRole("button", { name: "Send message" }));

		await waitFor(() =>
			expect(client.api.chats.send).toHaveBeenCalledWith({
				params: { chatId: chat.id },
				payload: { id: expect.any(String), message: "Send the update", peopleOnly: false },
			}),
		);
		await waitFor(() => expect(messages.scrollTop).toBe(1_200));
	});

	it("keeps writing to people only after a message is sent", async () => {
		const jyeInThread = {
			kind: "person" as const,
			id: jye.id,
			name: jye.name,
			handle: handleFromName(jye.name),
			image: null,
		};
		const withJye = details(chat.mainThreadId, "Chat", "chat", [mainMessage, agentMessage]);
		client.api.threads.get.mockReturnValue(
			Effect.succeed({ ...withJye, participants: [...withJye.participants, jyeInThread] }),
		);
		client.api.chats.send.mockReturnValue(
			Effect.succeed({ message: mainMessage, routing: { status: "routed" } }),
		);
		mount(`/suga/pods/suga-team/agents/${linear.handle}`);
		fireEvent.click(await screen.findByRole("button", { name: "People only" }));
		const composer = await screen.findByLabelText(`Message ${jye.name}`);
		fireEvent.change(composer, { target: { value: "Just between us" } });
		fireEvent.click(screen.getByRole("button", { name: "Send message" }));

		await waitFor(() =>
			expect(client.api.chats.send).toHaveBeenCalledWith({
				params: { chatId: chat.id },
				payload: { id: expect.any(String), message: "Just between us", peopleOnly: true },
			}),
		);
		expect(screen.getByRole("button", { name: "People only" }).getAttribute("aria-pressed")).toBe(
			"true",
		);
	});

	it("offers the pod's other bots to mention, though they never join the chat, and not you", async () => {
		mount(`/suga/pods/suga-team/agents/${linear.handle}`);
		const composer = await screen.findByLabelText(`Message ${linear.name}`);
		fireEvent.change(composer, { target: { value: "@" } });

		const list = within(await screen.findByRole("listbox"));
		expect(list.getByRole("option", { name: new RegExp(triager.name) })).toBeTruthy();
		expect(list.queryByRole("option", { name: new RegExp(sam.name) })).toBeNull();
		expect(list.getAllByRole("option")).toHaveLength(2);
	});

	it("offers no composer to an agent with no model, and says where to choose one", async () => {
		client.api.agents.list.mockReturnValue(
			Effect.succeed(agents.map((one) => (one.id === linear.id ? { ...one, model: null } : one))),
		);
		mount(`/suga/pods/suga-team/agents/${linear.handle}`);

		expect(await screen.findByText(/has no model yet, so it cannot answer/)).toBeDefined();
		expect(screen.getByRole("link", { name: "Choose a model" }).getAttribute("href")).toBe(
			`/suga/settings/pods/suga-team/agents/${linear.handle}`,
		);
		expect(screen.queryByLabelText(`Message ${linear.name}`)).toBeNull();
	});

	it("clears the composer while the message is still in flight", async () => {
		const posting = pendingAnswer();
		client.api.chats.send.mockReturnValue(posting.effect);
		mount(`/suga/pods/suga-team/agents/${linear.handle}`);
		const composer = (await screen.findByLabelText(
			`Message ${linear.name}`,
		)) as HTMLTextAreaElement;
		fireEvent.change(composer, { target: { value: "Send the update" } });
		fireEvent.click(screen.getByRole("button", { name: "Send message" }));

		await waitFor(() => expect(composer.value).toBe(""));
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
			Effect.fail(new InternalServerError({ message: "Nope" })),
		);
		mount(`/suga/pods/suga-team/agents/${linear.handle}`);
		const composer = (await screen.findByLabelText(
			`Message ${linear.name}`,
		)) as HTMLTextAreaElement;
		fireEvent.change(composer, { target: { value: "Send the update" } });
		fireEvent.click(screen.getByRole("button", { name: "Send message" }));

		await screen.findByText("Message not sent. Your draft is still here.");
		expect(composer.value).toBe("Send the update");
	});

	it("keeps an unsent draft while you are elsewhere, with the cursor at its end", async () => {
		const router = mount(`/suga/pods/suga-team/agents/${linear.handle}`);
		fireEvent.change(await screen.findByLabelText(`Message ${linear.name}`), {
			target: { value: "Half a thought" },
		});

		const composer = await leaveAndReturn(router);
		expect(composer.value).toBe("Half a thought");
		expect(composer.selectionStart).toBe("Half a thought".length);
	});

	it("forgets the draft once it is sent", async () => {
		client.api.chats.send.mockReturnValue(
			Effect.succeed({ message: mainMessage, routing: { status: "routed" } }),
		);
		const router = mount(`/suga/pods/suga-team/agents/${linear.handle}`);
		fireEvent.change(await screen.findByLabelText(`Message ${linear.name}`), {
			target: { value: "Send the update" },
		});
		fireEvent.click(screen.getByRole("button", { name: "Send message" }));
		await waitFor(() => expect(client.api.chats.send).toHaveBeenCalled());

		const composer = await leaveAndReturn(router);
		expect(composer.value).toBe("");
	});

	it("keeps following the latest message while the agent works, and when it answers", async () => {
		const updates = controlledEventStream();
		client.events.thread.mockReturnValue(updates.stream);
		mount(`/suga/pods/suga-team/agents/${linear.handle}`);
		const messages = await screen.findByRole("log", { name: "Chat messages" });
		let scrollHeight = 1_200;
		Object.defineProperties(messages, {
			scrollHeight: { configurable: true, get: () => scrollHeight },
			clientHeight: { configurable: true, value: 400 },
		});
		messages.scrollTop = 800;
		fireEvent.scroll(messages);
		await waitFor(() => expect(client.events.thread).toHaveBeenCalledWith(chat.mainThreadId));

		const streaming = {
			...agentMessage,
			id: "0199a3a0-0000-7000-8000-0000000000fb",
			status: "streaming" as const,
			content: "Starting",
			parts: [{ type: "text" as const, text: "Starting" }],
			createdAt: "2026-09-18T09:20:00.000Z",
		};
		scrollHeight = 1_400;
		updates.emit(
			streamEvent("message.created", { threadId: chat.mainThreadId, message: streaming }),
		);
		await screen.findByRole("status", { name: `${linear.name} is typing` });
		await waitFor(() => expect(messages.scrollTop).toBe(1_400));

		scrollHeight = 1_700;
		updates.emit(
			streamEvent("message.completed", {
				threadId: chat.mainThreadId,
				messageId: streaming.id,
				content: "Starting the response",
				status: "complete",
			}),
		);
		await screen.findByText("Starting the response");
		await waitFor(() => expect(messages.scrollTop).toBe(1_700));
	});

	it("shows the reply that finished while you were elsewhere", async () => {
		const writing: Message = {
			...agentMessage,
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
		const threadWith = (reply: Message) =>
			Effect.succeed(details(chat.mainThreadId, "Chat", "chat", [mainMessage, reply]));
		client.api.threads.get.mockReturnValue(threadWith(writing));
		const router = mount(`/suga/pods/suga-team/agents/${linear.handle}`);
		await screen.findByRole("status", { name: `${linear.name} is typing` });

		client.api.threads.get.mockReturnValue(threadWith(answered));
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
		mount(`/suga/pods/suga-team/agents/${linear.handle}`);
		// The chat loads after the first render, so the log is not there to watch until it has.
		const messages = await screen.findByRole("log", { name: "Chat messages" });
		messages.scrollTop = 800;

		height = 300;
		resizes.of(messages);

		expect(messages.scrollTop).toBe(1_100);
	});

	describe("messages waiting for the next reply", () => {
		const writing: Message = {
			...agentMessage,
			id: "0199a3a0-0000-7000-8000-0000000000fc",
			status: "streaming",
			content: "",
			parts: [],
			createdAt: "2026-09-18T09:20:00.000Z",
		};
		const followUp: Message = {
			...mainMessage,
			id: "0199a3a0-0000-7000-8000-0000000000fd",
			author: {
				kind: "person",
				id: "0199a3a0-0000-7000-8000-0000000000fe",
				name: "Jay Park",
				handle: "jay-park",
				image: null,
			},
			content: "Is the Stripe webhook part of it?",
			parts: [{ type: "text", text: "Is the Stripe webhook part of it?" }],
			createdAt: "2026-09-18T09:21:00.000Z",
		};
		/** The main thread as the server has it, with `queuedSince` when a turn started waiting. */
		const serverHas = (queuedSince: string | null) =>
			client.api.threads.get.mockReturnValue(
				Effect.succeed({
					...details(chat.mainThreadId, "Chat", "chat", [mainMessage, writing, followUp]),
					queuedSince,
				}),
			);

		async function watchWhileReplying() {
			const updates = controlledEventStream();
			client.events.thread.mockReturnValue(updates.stream);
			serverHas(null);
			mount(`/suga/pods/suga-team/agents/${linear.handle}`);
			await screen.findByRole("log", { name: "Chat messages" });
			await waitFor(() => expect(client.events.thread).toHaveBeenCalledWith(chat.mainThreadId));
			updates.emit(
				streamEvent("message.created", { threadId: chat.mainThreadId, message: writing }),
			);
			updates.emit(
				streamEvent("message.created", { threadId: chat.mainThreadId, message: followUp }),
			);
			await screen.findByText("Is the Stripe webhook part of it?");
			return updates;
		}

		it("says a message waits for the next reply, until that reply starts", async () => {
			const updates = await watchWhileReplying();

			serverHas(followUp.createdAt);
			updates.emit(streamEvent("thread.changed", { threadId: chat.mainThreadId }));
			await screen.findByRole("article", { name: "Jay Park, queued" });

			serverHas(null);
			updates.emit(
				streamEvent("turn.started", {
					threadId: chat.mainThreadId,
					turnId: "0199a3a0-0000-7000-8000-0000000000ff",
					agentId: linear.id,
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

	it("shows what the agent said before a collaboration while it waits on the answer", async () => {
		// The lead-in used to wait for the whole reply, then land above the
		// collaboration row and the typing line that had already been drawn.
		const waiting = {
			...agentMessage,
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
		client.api.threads.get.mockReturnValue(
			Effect.succeed(details(chat.mainThreadId, "Chat", "chat", [mainMessage, waiting])),
		);
		mount(`/suga/pods/suga-team/agents/${linear.handle}`);

		const leadIn = await screen.findByText("Checking ownership.");
		const collaboration = screen.getByRole("button", {
			name: new RegExp(`^Open Collaboration: ${linear.name} .*${triager.name}`),
		});
		const follows = (first: Node, second: Node) =>
			Boolean(first.compareDocumentPosition(second) & Node.DOCUMENT_POSITION_FOLLOWING);
		expect(follows(leadIn, collaboration)).toBe(true);
		// While the collaboration runs the bot says nothing else; its line says it is talking.
		expect(collaboration.getAttribute("aria-label")).toContain("is talking to");
		expect(screen.queryByRole("status", { name: /is typing/ })).toBeNull();
	});

	it("opens a read-only collaboration panel from an inline part", async () => {
		const router = mount(`/suga/pods/suga-team/agents/${linear.handle}`);
		fireEvent.click(
			await screen.findByRole("button", {
				name: new RegExp(`^Open Collaboration: ${linear.name} .*${triager.name}`),
			}),
		);

		const panel = await screen.findByRole("complementary", { name: collaborationEntry.title });
		// Seen from the chat's bot: its request on the right, the answer it got on the left.
		const request = within(panel).getByRole("article", { name: new RegExp(linear.name) });
		expect(within(request).getByText(collaborationRequest.content)).toBeDefined();
		expect(request.classList.contains("items-end")).toBe(true);
		expect(within(panel).queryByText("The request")).toBeNull();
		const answer = within(panel).getByRole("article", { name: new RegExp(triager.name) });
		expect(within(answer).getByText(collaborationAnswer.content)).toBeDefined();
		expect(answer.classList.contains("items-start")).toBe(true);
		expect(within(panel).getByText(`with ${triager.name}`)).toBeDefined();
		expect(within(panel).queryByRole("textbox")).toBeNull();
		await waitFor(() => expect(router.state.location.search.thread).toBe(collaborationId));
	});

	it("opens a thread at the beginning instead of scrolling to the latest message", async () => {
		const originalScrollHeight = Object.getOwnPropertyDescriptor(
			HTMLElement.prototype,
			"scrollHeight",
		);
		Object.defineProperty(HTMLElement.prototype, "scrollHeight", {
			configurable: true,
			get: () => 1_200,
		});
		try {
			mount(`/suga/pods/suga-team/agents/${linear.handle}`);
			fireEvent.click(
				await screen.findByRole("button", {
					name: new RegExp(`^Open Collaboration: ${linear.name} .*${triager.name}`),
				}),
			);

			const timeline = await screen.findByRole("log", { name: "Thread messages" });
			expect(timeline.scrollTop).toBe(0);
		} finally {
			if (originalScrollHeight) {
				Object.defineProperty(HTMLElement.prototype, "scrollHeight", originalScrollHeight);
			} else {
				Reflect.deleteProperty(HTMLElement.prototype, "scrollHeight");
			}
		}
	});

	it("shows an inbound collaboration and opens its thread from the recipient Chat", async () => {
		client.api.chats.messages.mockReturnValue(
			Effect.succeed({
				items: [
					{
						kind: "collaboration",
						id: collaborationPart.id,
						threadId: collaborationId,
						initiator: collaborator,
						createdAt: collaborationRequest.createdAt,
					},
				],
				nextCursor: null,
			}),
		);
		client.api.threads.get.mockImplementation(({ params }: { params: { threadId: string } }) => {
			if (params.threadId === collaborationId) {
				const inbound = details(collaborationId, collaborationEntry.title, "collaboration", [
					collaborationRequest,
					collaborationAnswer,
				]);
				return Effect.succeed({
					...inbound,
					thread: { ...inbound.thread, chatId: "0199a3a0-0000-7000-8000-000000000099" },
				});
			}
			return Effect.succeed(details(chat.mainThreadId, "Chat", "chat", []));
		});

		mount(`/suga/pods/suga-team/agents/${linear.handle}`);
		fireEvent.click(
			await screen.findByRole("button", {
				name: new RegExp(`^Open Collaboration: ${linear.name} helped ${triager.name}`),
			}),
		);

		const panel = await screen.findByRole("complementary", { name: collaborationEntry.title });
		expect(within(panel).getByText(collaborationAnswer.content)).toBeDefined();
	});

	it("opens a routine run's panel from the thread query", async () => {
		const router = mount(`/suga/pods/suga-team/agents/${linear.handle}?thread=${routineId}`);

		const routinePanel = await screen.findByRole("complementary", { name: routineEntry.title });
		expect(
			within(routinePanel).getByRole("heading", { name: routineExecution.routineName }),
		).toBeDefined();
		expect(within(routinePanel).getByText("Routine run")).toBeDefined();
		expect(within(routinePanel).getByText(routineMessage.content)).toBeDefined();
		expect(within(routinePanel).queryByText(routineExecution.instructions)).toBeNull();
		expect(
			within(routinePanel)
				.getByRole("link", { name: "View routine definition" })
				.getAttribute("href"),
		).toBe(`/suga/settings/pods/suga-team/agents/${linear.handle}?tab=routines`);
		expect(within(routinePanel).getByLabelText("View webhook payload")).toBeDefined();
		expect(within(routinePanel).queryByText(/Routine instructions:/)).toBeNull();
		expect(within(routinePanel).queryByText(/Trigger data \(untrusted\):/)).toBeNull();
		expect(within(routinePanel).queryByRole("textbox")).toBeNull();
		expect(router.state.location.search.thread).toBe(routineId);
	});

	it("returns from a Routine collaboration to its parent Routine", async () => {
		mount(`/suga/pods/suga-team/agents/${linear.handle}?thread=${routineId}`);
		const routinePanel = await screen.findByRole("complementary", { name: routineEntry.title });
		fireEvent.click(
			within(routinePanel).getByRole("button", {
				name: new RegExp(`^Open Collaboration: ${linear.name} .*${triager.name}`),
			}),
		);

		const collaborationPanel = await screen.findByRole("complementary", {
			name: routineCollaborationEntry.title,
		});
		fireEvent.click(within(collaborationPanel).getByRole("button", { name: "Back to Routine" }));

		expect(await screen.findByRole("complementary", { name: routineEntry.title })).toBeDefined();
	});

	it("uses message-focused copy when the Chat is empty", async () => {
		client.api.chats.messages.mockReturnValue(Effect.succeed({ items: [], nextCursor: null }));
		client.api.threads.get.mockReturnValue(
			Effect.succeed(details(chat.mainThreadId, "Chat", "chat", [])),
		);
		mount(`/suga/pods/suga-team/agents/${linear.handle}`);

		expect(await screen.findByText(`Say hello to ${linear.name}`)).toBeDefined();
		expect(screen.getByText(`Your chats with ${linear.name} will show up here.`)).toBeDefined();
	});

	it("opens Details from the bot's name, and leads back to the pod's list", async () => {
		mount(`/suga/pods/suga-team/agents/${linear.handle}`);

		const name = await screen.findByRole("button", { name: linear.name });
		expect(screen.getByRole("link", { name: "Back to Suga-Team" }).getAttribute("href")).toBe(
			"/suga/pods/suga-team",
		);
		fireEvent.click(name);

		expect(await screen.findByRole("complementary", { name: "Details" })).toBeDefined();
	});

	it("leads from its bot's settings back to the Chat they were opened from", async () => {
		const chat = `/suga/pods/suga-team/agents/${linear.handle}`;
		const router = mount(chat);
		fireEvent.click(await screen.findByRole("button", { name: "Details" }));
		const details = await screen.findByRole("complementary", { name: "Details" });

		fireEvent.click(within(details).getByRole("link", { name: "Settings" }));
		await screen.findByRole("heading", { name: linear.name });
		fireEvent.click(screen.getByRole("link", { name: "Back to Chat" }));

		await waitFor(() => expect(router.state.location.pathname).toBe(chat));
	});

	it("lists who has written in the Chat lately, most recent first", async () => {
		mount(`/suga/pods/suga-team/agents/${linear.handle}`);
		fireEvent.click(await screen.findByRole("button", { name: "Details" }));

		const rail = await screen.findByRole("complementary", { name: "Details" });
		const recent = (
			await within(rail).findByRole("heading", { name: "Recent participants" })
		).closest("section");
		if (!recent) throw new Error("Recent participants has no section");
		const [first, second, ...rest] = within(recent).getAllByRole("listitem");
		expect(first?.textContent).toContain(linear.name);
		expect(second?.textContent).toContain(sam.name);
		expect(rest).toEqual([]);
	});

	it("closes a direct-linked collaboration without leaving Chat", async () => {
		const router = mount(`/suga/pods/suga-team/agents/${linear.handle}?thread=${collaborationId}`);
		const panel = await screen.findByRole("complementary", { name: collaborationEntry.title });
		expect(within(panel).getByRole("heading", { name: "Collaboration" })).toBeDefined();
		fireEvent.click(within(panel).getByRole("button", { name: "Close" }));

		await waitFor(() =>
			expect(screen.queryByRole("complementary", { name: collaborationEntry.title })).toBeNull(),
		);
		expect(router.state.location.pathname).toBe(`/suga/pods/suga-team/agents/${linear.handle}`);
	});
});

describe("people typing in the Chat", () => {
	const jyeInThread = {
		kind: "person" as const,
		id: jye.id,
		name: jye.name,
		handle: handleFromName(jye.name),
		image: null,
	};
	const jyeTyping = streamEvent("person.typing", {
		threadId: chat.mainThreadId,
		person: jyeInThread,
	});

	async function watchMainThread() {
		const updates = controlledEventStream();
		client.events.thread.mockReturnValue(updates.stream);
		mount(`/suga/pods/suga-team/agents/${linear.handle}`);
		await waitFor(() => expect(client.events.thread).toHaveBeenCalledWith(chat.mainThreadId));
		return updates;
	}

	afterEach(() => {
		vi.useRealTimers();
	});

	it("shows someone else typing until their message arrives", async () => {
		const updates = await watchMainThread();

		updates.emit(jyeTyping);
		await screen.findByRole("status", { name: "Jye is typing" });

		updates.emit(
			streamEvent("message.created", {
				threadId: chat.mainThreadId,
				message: {
					...mainMessage,
					id: "0199a3a0-0000-7000-8000-0000000000fc",
					author: jyeInThread,
					content: "Also, the deploy",
					parts: [{ type: "text", text: "Also, the deploy" }],
					createdAt: "2026-09-18T09:40:00.000Z",
				},
			}),
		);
		await screen.findByText("Also, the deploy");
		expect(screen.queryByRole("status", { name: "Jye is typing" })).toBeNull();
	});

	it("stops showing someone typing once they stop saying so", async () => {
		vi.useFakeTimers({ shouldAdvanceTime: true });
		const updates = await watchMainThread();

		updates.emit(jyeTyping);
		await screen.findByRole("status", { name: "Jye is typing" });

		await vi.advanceTimersByTimeAsync(7_000);
		await waitFor(() => expect(screen.queryByRole("status", { name: "Jye is typing" })).toBeNull());
	});

	it("shows someone under the message they have read up to as soon as they read it", async () => {
		const updates = await watchMainThread();
		await screen.findByText("Checking ownership.");
		expect(screen.queryByText("Read by Jye")).toBeNull();

		updates.emit(
			streamEvent("thread.read", {
				threadId: chat.mainThreadId,
				person: jyeInThread,
				readThrough: agentMessage.createdAt,
				readAt: "2026-09-18T09:30:00.000Z",
			}),
		);

		await screen.findByText("Read by Jye");
	});

	it("does not show you your own typing", async () => {
		const updates = await watchMainThread();

		updates.emit(streamEvent("person.typing", { threadId: chat.mainThreadId, person }));
		updates.emit(jyeTyping);

		await screen.findByRole("status", { name: "Jye is typing" });
		expect(screen.queryByRole("status", { name: /Sam/ })).toBeNull();
	});

	it("does not say you are typing just because a draft was kept from before", async () => {
		const router = mount(`/suga/pods/suga-team/agents/${linear.handle}`);
		fireEvent.change(await screen.findByLabelText(`Message ${linear.name}`), {
			target: { value: "Half a thought" },
		});
		await waitFor(() => expect(client.api.events.typing).toHaveBeenCalledTimes(1));
		client.api.events.typing.mockClear();
		client.events.thread.mockClear();

		await leaveAndReturn(router);
		await waitFor(() => expect(client.events.thread).toHaveBeenCalledWith(chat.mainThreadId));
		expect(client.api.events.typing).not.toHaveBeenCalled();
	});

	it("tells the thread you are typing, once for a burst of keystrokes", async () => {
		mount(`/suga/pods/suga-team/agents/${linear.handle}`);
		const composer = await screen.findByLabelText(`Message ${linear.name}`);

		fireEvent.change(composer, { target: { value: "S" } });
		fireEvent.change(composer, { target: { value: "Se" } });
		fireEvent.change(composer, { target: { value: "Sen" } });

		await waitFor(() =>
			expect(client.api.events.typing).toHaveBeenCalledWith({
				params: { threadId: chat.mainThreadId },
			}),
		);
		expect(client.api.events.typing).toHaveBeenCalledTimes(1);
	});
});

describe("a thread open beside the Chat", () => {
	const chatPage = `/suga/pods/suga-team/agents/${linear.handle}`;
	const threadPage = `${chatPage}?thread=${collaborationId}`;
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

	/** Answers for the open thread; every other thread keeps the Chat's own answers. */
	function answerThread(
		answer: (request: {
			params: { threadId: string };
			query?: { cursor?: string };
		}) => Effect.Effect<unknown, unknown>,
	) {
		const others = client.api.threads.get.getMockImplementation();
		client.api.threads.get.mockImplementation((request: { params: { threadId: string } }) =>
			request.params.threadId === collaborationId ? answer(request) : others?.(request),
		);
	}

	/** A stream for the open thread alone, so what it is sent is not also the Chat's. */
	function threadStream() {
		const updates = controlledEventStream();
		client.events.thread.mockImplementation((threadId: string) =>
			threadId === collaborationId ? updates.stream : controlledEventStream().stream,
		);
		return updates;
	}

	const threadCalls = () =>
		client.api.threads.get.mock.calls.filter(
			([request]) =>
				(request as { params: { threadId: string } }).params.threadId === collaborationId,
		);

	it("says why a reply failed, in the provider's words", async () => {
		answerThread(() =>
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
		mount(threadPage);

		const panel = await screen.findByRole("complementary", { name: collaborationEntry.title });
		expect(await within(panel).findByText("Reply failed.")).toBeDefined();
		expect(within(panel).getByText(/18\+ age confirmation/)).toBeDefined();
	});

	it("says why a reply is not coming, until the thread moves on", async () => {
		const updates = threadStream();
		answerThread(() => Effect.succeed(collaboration));
		mount(threadPage);
		const panel = await screen.findByRole("complementary", { name: collaborationEntry.title });
		await within(panel).findByText(collaborationAnswer.content);

		updates.emit(
			streamEvent("thread.notice", {
				threadId: collaborationId,
				notice: "Helper has no model chosen, so it cannot reply.",
			}),
		);

		const notices = within(panel).getByRole("status", { name: "Thread notices" });
		expect(
			await within(notices).findByText("Helper has no model chosen, so it cannot reply."),
		).toBeDefined();

		const messageId = "0199a3a0-0000-7000-8000-000000000102";
		updates.emit(
			streamEvent("message.created", {
				threadId: collaborationId,
				message: incoming(messageId, "Trying again"),
			}),
		);
		await within(panel).findByText("Trying again");
		expect(within(notices).queryByText(/has no model chosen/)).toBeNull();
	});

	it("says when the thread could not be loaded", async () => {
		answerThread(() => Effect.fail(new Forbidden({ message: "Unavailable" })));
		mount(threadPage);

		expect(await screen.findByText("Could not load this thread")).toBeDefined();
	});

	it("applies streamed messages to the thread once each", async () => {
		const updates = threadStream();
		answerThread(() => Effect.succeed(collaboration));
		mount(threadPage);
		const panel = await screen.findByRole("complementary", { name: collaborationEntry.title });
		await within(panel).findByText(collaborationAnswer.content);

		const messageId = "0199a3a0-0000-7000-8000-000000000101";
		const created = streamEvent("message.created", {
			threadId: collaborationId,
			message: { ...incoming(messageId, ""), status: "streaming", parts: [] },
		});
		updates.emit(created);
		updates.emit(created);
		updates.emit(
			streamEvent("message.delta", {
				threadId: collaborationId,
				messageId,
				offset: 0,
				text: "Release checked",
			}),
		);
		updates.emit(
			streamEvent("message.completed", {
				threadId: collaborationId,
				messageId,
				content: "Release checked",
				status: "complete",
			}),
		);

		expect(await within(panel).findByText("Release checked")).toBeDefined();
		expect(within(panel).getAllByText("Release checked")).toHaveLength(1);
	});

	it("loads and deduplicates older messages while keeping live updates", async () => {
		const updates = threadStream();
		const cursor = "older-page";
		const earlier = { ...incoming("0199a3a0-0000-7000-8000-000000000102", "Earlier context") };
		earlier.createdAt = "2026-09-18T09:00:00.000Z";
		answerThread((request) =>
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
		mount(threadPage);
		const panel = await screen.findByRole("complementary", { name: collaborationEntry.title });

		fireEvent.click(await within(panel).findByRole("button", { name: "Load older messages" }));

		expect(await within(panel).findByText("Earlier context")).toBeDefined();
		expect(within(panel).getAllByText(collaborationRequest.content)).toHaveLength(1);
		expect(client.api.threads.get).toHaveBeenCalledWith({
			params: { threadId: collaborationId },
			query: { cursor, limit: DEFAULT_THREAD_HISTORY_LIMIT },
		});

		updates.emit(
			streamEvent("message.created", {
				threadId: collaborationId,
				message: incoming("0199a3a0-0000-7000-8000-000000000103", "Live after paging"),
			}),
		);
		expect(await within(panel).findByText("Live after paging")).toBeDefined();
		expect(within(panel).getByText("Earlier context")).toBeDefined();
	});

	it("keeps current thread metadata and messages when an older page resolves late", async () => {
		const updates = threadStream();
		const olderPage = pendingAnswer();
		answerThread((request) =>
			request.query?.cursor
				? olderPage.effect
				: Effect.succeed({ ...collaboration, olderMessagesCursor: "older-page" }),
		);
		mount(threadPage);
		const panel = await screen.findByRole("complementary", { name: collaborationEntry.title });
		fireEvent.click(await within(panel).findByRole("button", { name: "Load older messages" }));

		updates.emit(
			streamEvent("message.completed", {
				threadId: collaborationId,
				messageId: collaborationAnswer.id,
				status: "complete",
				content: "Completed while paging",
			}),
		);
		expect(await within(panel).findByText("Completed while paging")).toBeDefined();

		olderPage.answer(
			Effect.succeed({
				...collaboration,
				thread: { ...collaboration.thread, title: "Stale page title" },
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
		answerThread((request) =>
			request.query?.cursor
				? Effect.fail(new InternalServerError({ message: "History unavailable" }))
				: Effect.succeed({ ...collaboration, olderMessagesCursor: "older-page" }),
		);
		mount(threadPage);
		const panel = await screen.findByRole("complementary", { name: collaborationEntry.title });

		fireEvent.click(await within(panel).findByRole("button", { name: "Load older messages" }));

		expect((await within(panel).findByRole("alert")).textContent).toContain(
			"Earlier messages could not be loaded.",
		);
		expect(
			within(panel).getByRole("button", { name: "Load older messages" }).hasAttribute("disabled"),
		).toBe(false);
	});

	it("refetches when an event arrives before the thread has loaded", async () => {
		const updates = threadStream();
		const initial = pendingAnswer();
		const early = incoming("0199a3a0-0000-7000-8000-000000000104", "Arrived early");
		let first = true;
		answerThread(() => {
			if (first) {
				first = false;
				return initial.effect;
			}
			return Effect.succeed({ ...collaboration, messages: [...collaboration.messages, early] });
		});
		mount(threadPage);
		await waitFor(() => expect(client.events.thread).toHaveBeenCalledWith(collaborationId));

		updates.emit(streamEvent("message.created", { threadId: collaborationId, message: early }));
		initial.answer(Effect.succeed(collaboration));

		expect(await screen.findByText("Arrived early")).toBeDefined();
		expect(threadCalls()).toHaveLength(2);
	});

	it("says the bot is typing from when its reply starts until it is finished", async () => {
		const updates = threadStream();
		answerThread(() =>
			Effect.succeed({
				...collaboration,
				thread: { ...collaboration.thread, status: "running" },
				messages: [collaborationRequest],
			}),
		);
		mount(threadPage);
		const panel = await screen.findByRole("complementary", { name: collaborationEntry.title });
		await within(panel).findByText(collaborationRequest.content);

		updates.emit(
			streamEvent("message.created", {
				threadId: collaborationId,
				message: { ...collaborationAnswer, status: "streaming", content: "", parts: [] },
			}),
		);
		updates.emit(
			streamEvent("message.delta", {
				threadId: collaborationId,
				messageId: collaborationAnswer.id,
				offset: 0,
				text: "Sam ",
			}),
		);
		// One line for the whole reply, and none of its words until it is done.
		expect(
			await within(panel).findAllByRole("status", { name: `${triager.name} is typing` }),
		).toHaveLength(1);
		expect(within(panel).queryByText("Sam")).toBeNull();

		updates.emit(
			streamEvent("message.completed", {
				threadId: collaborationId,
				messageId: collaborationAnswer.id,
				content: "Sam owns it.",
				status: "complete",
			}),
		);

		expect(await within(panel).findByText("Sam owns it.")).toBeDefined();
		expect(within(panel).queryByRole("status", { name: `${triager.name} is typing` })).toBeNull();
	});

	it("answers the call the thread waits on from the foot of a phone's sheet", async () => {
		client.api.toolApprovals.decide.mockReturnValue(Effect.undefined);
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
			approval: { status: "pending" as const, decidedByName: null, decidedAt: null },
		};
		answerThread(() =>
			Effect.succeed({
				...collaboration,
				capabilities: { ...collaboration.capabilities, approveToolCalls: true },
				messages: [
					collaborationRequest,
					{ ...collaborationAnswer, parts: [...collaborationAnswer.parts, waitingCall] },
				],
			}),
		);
		mount(threadPage);
		const panel = await screen.findByRole("complementary", { name: collaborationEntry.title });

		fireEvent.click(await within(panel).findByRole("button", { name: "Allow: Create issue" }));

		await waitFor(() =>
			expect(client.api.toolApprovals.decide).toHaveBeenCalledWith({
				params: { podId: collaboration.thread.podId, toolCallId: waitingCall.id },
				payload: { decision: "allow_once" },
			}),
		);
	});

	it("closes the thread's stream when the sidebar closes", async () => {
		const updates = threadStream();
		answerThread(() => Effect.succeed(collaboration));
		mount(threadPage);
		const panel = await screen.findByRole("complementary", { name: collaborationEntry.title });
		await within(panel).findByText(collaborationAnswer.content);

		fireEvent.click(within(panel).getByRole("button", { name: "Close" }));

		await waitFor(() => expect(updates.close).toHaveBeenCalledOnce());
	});
});

describe("the Chat's summary", () => {
	const chatPage = `/suga/pods/suga-team/agents/${linear.handle}`;

	function answerChatActivity(activity: () => ThreadActivity) {
		client.api.threads.activity.mockImplementation(() => Effect.sync(activity));
	}

	function scribeWithoutModel() {
		client.api.systemAgents.list.mockReturnValue(
			Effect.succeed(
				builtInAgents.map((agent) =>
					agent.key === "summarise" ? { ...agent, model: null } : agent,
				),
			),
		);
	}

	async function openDetails() {
		fireEvent.click(await screen.findByRole("button", { name: "Details" }));
		return screen.findByRole("complementary", { name: "Details" });
	}

	it("says the Scribe has no model, and where to set it up", async () => {
		scribeWithoutModel();
		answerChatActivity(() => ({ ...chatActivity, summary: null }));
		mount(chatPage);
		const sidebar = await openDetails();

		expect(await within(sidebar).findByText(/The Scribe writes these/)).toBeDefined();
		expect(
			within(sidebar).getByRole("link", { name: "Set up the Scribe" }).getAttribute("href"),
		).toBe("/suga/settings/providers/system");
	});

	it("tells a member why there is no summary without a link they cannot follow", async () => {
		apiAnswers({ role: "member" });
		chatAnswers();
		scribeWithoutModel();
		answerChatActivity(() => ({ ...chatActivity, summary: null }));
		mount(chatPage);
		const sidebar = await openDetails();

		expect(await within(sidebar).findByText(/The Scribe writes these/)).toBeDefined();
		expect(within(sidebar).queryByRole("link", { name: "Set up the Scribe" })).toBeNull();
	});

	it("says nothing about setting the Scribe up before the built-in agents have loaded", async () => {
		client.api.systemAgents.list.mockReturnValue(Effect.never);
		answerChatActivity(() => ({ ...chatActivity, summary: null }));
		mount(chatPage);
		const sidebar = await openDetails();

		expect(
			await within(sidebar).findByText("A summary will appear after the first reply."),
		).toBeDefined();
		expect(within(sidebar).queryByRole("link", { name: "Set up the Scribe" })).toBeNull();
	});

	it("shows a new summary once the thread says it changed", async () => {
		const updates = controlledEventStream();
		client.events.thread.mockImplementation((threadId: string) =>
			threadId === chat.mainThreadId ? updates.stream : controlledEventStream().stream,
		);
		let summarised = false;
		answerChatActivity(() => (summarised ? chatActivity : { ...chatActivity, summary: null }));
		mount(chatPage);
		const sidebar = await openDetails();
		expect(
			await within(sidebar).findByText("A summary will appear after the first reply."),
		).toBeDefined();

		summarised = true;
		updates.emit(streamEvent("thread.changed", { threadId: chat.mainThreadId }));

		expect(await within(sidebar).findByText("Chat is complete.")).toBeDefined();
	});
});
