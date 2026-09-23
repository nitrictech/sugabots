import {
	type Chat,
	type ChatHistoryEntry,
	handleFromName,
	type Message,
	type RoutineExecution,
	streamEvent,
	type ThreadDetails,
} from "@sugabots/contracts";
import { InternalServerError } from "@sugabots/contracts/http";
import { cleanup, fireEvent, screen, waitFor, within } from "@testing-library/react";
import { Effect } from "effect";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
	agents,
	apiAnswers,
	controlledEventStream,
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
	email: sam.email,
	handle: handleFromName(sam.name),
	image: null,
};
const host = {
	kind: "agent" as const,
	id: linear.id,
	name: linear.name,
	handle: linear.handle,
	hue: linear.hue,
	face: linear.face,
};
const collaborator = {
	kind: "agent" as const,
	id: triager.id,
	name: triager.name,
	handle: triager.handle,
	hue: triager.hue,
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
		activeTurnId: null,
		routineExecution: type === "routine" ? routineExecution : null,
		participants: type === "collaboration" ? [host, collaborator] : [person, host],
		crew: [host, collaborator],
		messages,
		olderMessagesCursor: null,
		summary: {
			content: `${title} is complete.`,
			sourceMessageId: messages.at(-1)?.id ?? mainMessage.id,
			updatedAt: "2026-09-18T09:22:00.000Z",
		},
		usage: {
			modelCalls: 2,
			inputTokens: 100,
			outputTokens: 50,
			totalTokens: 150,
			reportedCost: 0.01,
			latestContext: { usedTokens: 1_000, capacityTokens: 10_000 },
		},
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

beforeEach(() => {
	apiAnswers();
	chatAnswers();
});

afterEach(() => {
	cleanup();
	vi.clearAllMocks();
});

describe("ongoing agent Chat", () => {
	it("renders main messages and inline collaborations", async () => {
		mount(`/agents/${linear.id}?pod=${linear.podId}`);

		const personMessage = (await screen.findByText(mainMessage.content)).closest("article");
		expect(personMessage?.classList.contains("justify-end")).toBe(true);
		const reply = screen.getByText(agentMessage.content).closest("article");
		expect(reply?.classList.contains("justify-start")).toBe(true);
		const collaboration = screen.getByRole("button", {
			name: `Open Collaboration: ${linear.name} talked to ${triager.name}`,
		});
		expect(collaboration.querySelectorAll(".agent-tint")).toHaveLength(2);
		expect(client.api.chats.getOrCreate).toHaveBeenCalledWith({
			params: { workspaceId: linear.workspaceId },
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
		mount(`/agents/${linear.id}`);

		const activity = await screen.findByRole("button", {
			name: `Open Routine run: ${routineExecution.routineName}`,
		});
		expect(activity.querySelector(".lucide-webhook")).not.toBeNull();
		expect(screen.queryByText(`Start a conversation with ${linear.name}`)).toBeNull();
	});

	it("sends a main-chat message", async () => {
		client.api.chats.send.mockReturnValue(
			Effect.succeed({ message: mainMessage, routing: { status: "routed" } }),
		);
		mount(`/agents/${linear.id}`);
		const messages = await screen.findByRole("log", { name: "Chat messages" });
		Object.defineProperty(messages, "scrollHeight", { configurable: true, value: 1_200 });
		messages.scrollTop = 100;
		const composer = await screen.findByLabelText(`Message ${linear.name}`);
		fireEvent.change(composer, { target: { value: "  Send the update  " } });
		fireEvent.click(screen.getByRole("button", { name: "Send message" }));

		await waitFor(() =>
			expect(client.api.chats.send).toHaveBeenCalledWith({
				params: { chatId: chat.id },
				payload: { id: expect.any(String), message: "Send the update" },
			}),
		);
		await waitFor(() => expect(messages.scrollTop).toBe(1_200));
	});

	it("offers no composer to an agent with no model, and says where to choose one", async () => {
		client.api.agents.list.mockReturnValue(
			Effect.succeed(agents.map((one) => (one.id === linear.id ? { ...one, model: null } : one))),
		);
		mount(`/agents/${linear.id}`);

		expect(await screen.findByText(/has no model yet, so it cannot answer/)).toBeDefined();
		expect(screen.getByRole("link", { name: "Choose a model" }).getAttribute("href")).toBe(
			`/settings/pods/${linear.podId}/agents/${linear.id}`,
		);
		expect(screen.queryByLabelText(`Message ${linear.name}`)).toBeNull();
	});

	it("clears the composer while the message is still in flight", async () => {
		const posting = pendingAnswer();
		client.api.chats.send.mockReturnValue(posting.effect);
		mount(`/agents/${linear.id}`);
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
		mount(`/agents/${linear.id}`);
		const composer = (await screen.findByLabelText(
			`Message ${linear.name}`,
		)) as HTMLTextAreaElement;
		fireEvent.change(composer, { target: { value: "Send the update" } });
		fireEvent.click(screen.getByRole("button", { name: "Send message" }));

		await screen.findByText("Message not sent. Your draft is still here.");
		expect(composer.value).toBe("Send the update");
	});

	it("keeps following the latest message while the agent writes", async () => {
		const updates = controlledEventStream();
		client.events.thread.mockReturnValue(updates.stream);
		mount(`/agents/${linear.id}`);
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
		await screen.findByText("Starting");
		await waitFor(() => expect(messages.scrollTop).toBe(1_400));

		scrollHeight = 1_700;
		updates.emit(
			streamEvent("message.delta", {
				threadId: chat.mainThreadId,
				messageId: streaming.id,
				offset: streaming.content.length,
				text: " the response",
			}),
		);
		await screen.findByText("Starting the response");
		await waitFor(() => expect(messages.scrollTop).toBe(1_700));
	});

	it("opens a read-only collaboration panel from an inline part", async () => {
		const router = mount(`/agents/${linear.id}`);
		fireEvent.click(
			await screen.findByRole("button", {
				name: `Open Collaboration: ${linear.name} talked to ${triager.name}`,
			}),
		);

		const panel = await screen.findByRole("complementary", { name: collaborationEntry.title });
		const request = within(panel).getByRole("article", { name: new RegExp(linear.name) });
		expect(within(request).getByText(collaborationRequest.content)).toBeDefined();
		expect(request.classList.contains("justify-start")).toBe(true);
		expect(within(panel).queryByText("The request")).toBeNull();
		const answer = within(panel).getByRole("article", { name: new RegExp(triager.name) });
		expect(within(answer).getByText(collaborationAnswer.content)).toBeDefined();
		expect(answer.classList.contains("justify-end")).toBe(true);
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
			mount(`/agents/${linear.id}`);
			fireEvent.click(
				await screen.findByRole("button", {
					name: `Open Collaboration: ${linear.name} talked to ${triager.name}`,
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

		mount(`/agents/${linear.id}`);
		fireEvent.click(
			await screen.findByRole("button", {
				name: `Open Collaboration: ${triager.name} contacted me`,
			}),
		);

		const panel = await screen.findByRole("complementary", { name: collaborationEntry.title });
		expect(within(panel).getByText(collaborationAnswer.content)).toBeDefined();
	});

	it("lists only collaborations and routine runs in compact day groups", async () => {
		mount(`/agents/${linear.id}`);
		fireEvent.click(
			(await screen.findAllByRole("button", { name: "Open Chat history" }))[0] as Element,
		);

		const history = await screen.findByRole("complementary", { name: "Chat history" });
		expect(within(history).getByText(collaborationEntry.title)).toBeDefined();
		expect(within(history).getByText(routineEntry.title)).toBeDefined();
		expect(
			within(history)
				.getAllByRole("button")
				.some((button) => button.querySelector("svg")),
		).toBe(true);
		expect(within(history).getByRole("heading", { level: 3 })).toBeDefined();
	});

	it("opens collaboration and routine panels from history through the thread query", async () => {
		const router = mount(`/agents/${linear.id}?history=open`);
		const history = await screen.findByRole("complementary", { name: "Chat history" });
		fireEvent.click(within(history).getByRole("button", { name: collaborationEntry.title }));

		expect(await screen.findByRole("heading", { name: collaborationEntry.title })).toBeDefined();
		await waitFor(() => expect(router.state.location.search.thread).toBe(collaborationId));
		fireEvent.click(within(history).getByRole("button", { name: routineEntry.title }));

		const routinePanel = await screen.findByRole("complementary", { name: routineEntry.title });
		expect(routinePanel.querySelector(".lucide-webhook")).not.toBeNull();
		expect(within(routinePanel).getByText(routineMessage.content)).toBeDefined();
		expect(within(routinePanel).queryByText(routineExecution.instructions)).toBeNull();
		expect(
			within(routinePanel)
				.getByRole("link", { name: "View routine definition" })
				.getAttribute("href"),
		).toBe(`/settings/pods/${linear.podId}/agents/${linear.id}?tab=routines`);
		expect(within(routinePanel).getByLabelText("View webhook payload")).toBeDefined();
		expect(within(routinePanel).queryByText(/Routine instructions:/)).toBeNull();
		expect(within(routinePanel).queryByText(/Trigger data \(untrusted\):/)).toBeNull();
		expect(within(routinePanel).queryByRole("textbox")).toBeNull();
		await waitFor(() => expect(router.state.location.search.thread).toBe(routineId));
	});

	it("returns from a Routine collaboration to its parent Routine", async () => {
		mount(`/agents/${linear.id}?history=open`);
		const history = await screen.findByRole("complementary", { name: "Chat history" });
		fireEvent.click(within(history).getByRole("button", { name: routineEntry.title }));
		const routinePanel = await screen.findByRole("complementary", { name: routineEntry.title });
		fireEvent.click(
			within(routinePanel).getByRole("button", {
				name: `Open Collaboration: ${linear.name} talked to ${triager.name}`,
			}),
		);

		const collaborationPanel = await screen.findByRole("complementary", {
			name: routineCollaborationEntry.title,
		});
		fireEvent.click(within(collaborationPanel).getByRole("button", { name: "Back to Routine" }));

		expect(await screen.findByRole("complementary", { name: routineEntry.title })).toBeDefined();
	});

	it("paginates collaboration and routine history", async () => {
		client.api.chats.history
			.mockReturnValueOnce(Effect.succeed({ items: [collaborationEntry], nextCursor: "older" }))
			.mockReturnValueOnce(Effect.succeed({ items: [routineEntry], nextCursor: null }));
		mount(`/agents/${linear.id}?history=open`);
		const history = await screen.findByRole("complementary", { name: "Chat history" });
		fireEvent.click(within(history).getByRole("button", { name: "Load older threads" }));

		expect(await within(history).findByText(routineEntry.title)).toBeDefined();
	});

	it("uses message-focused copy when the Chat is empty", async () => {
		client.api.chats.messages.mockReturnValue(Effect.succeed({ items: [], nextCursor: null }));
		client.api.threads.get.mockReturnValue(
			Effect.succeed(details(chat.mainThreadId, "Chat", "chat", [])),
		);
		mount(`/agents/${linear.id}`);

		expect(await screen.findByText(`Start a conversation with ${linear.name}`)).toBeDefined();
		expect(screen.getByText("Send a message to start working together.")).toBeDefined();
	});

	it("closes a direct-linked collaboration without leaving Chat", async () => {
		const router = mount(`/agents/${linear.id}?thread=${collaborationId}`);
		expect(await screen.findByRole("heading", { name: collaborationEntry.title })).toBeDefined();
		fireEvent.click(screen.getByRole("button", { name: "Close thread (Escape)" }));

		await waitFor(() =>
			expect(screen.queryByRole("heading", { name: collaborationEntry.title })).toBeNull(),
		);
		expect(router.state.location.pathname).toBe(`/agents/${linear.id}`);
	});
});
