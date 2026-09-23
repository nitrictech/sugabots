import {
	DEFAULT_THREAD_HISTORY_LIMIT,
	handleFromName,
	streamEvent,
	type ThreadDetails,
} from "@sugabots/contracts";
import { Forbidden, InternalServerError } from "@sugabots/contracts/http";
import { cleanup, fireEvent, screen, waitFor } from "@testing-library/react";
import { Effect } from "effect";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
	apiAnswers,
	controlledEventStream,
	linear,
	mount,
	pendingAnswer,
	pods,
	sam,
	triager,
} from "@/test-api.tsx";
import { client } from "@/test-client.ts";

vi.mock("@/api.ts", () => import("@/test-client.ts"));

const threadDetails: ThreadDetails = {
	thread: {
		id: "0199a3a0-0000-7000-8000-0000000000c1",
		workspaceId: linear.workspaceId,
		podId: pods[0]?.id as string,
		hostAgentId: linear.id,
		chatId: null,
		type: "chat",
		title: "Draft release notes",
		status: "done",
		parentThreadId: null,
		initiatorUserId: sam.id,
		createdAt: "2026-09-10T04:00:00.000Z",
		updatedAt: "2026-09-10T04:00:00.000Z",
	},
	activeTurnId: null,
	routineExecution: null,
	summary: {
		content: "The release notes are drafted and ready for review.",
		sourceMessageId: "0199a3a0-0000-7000-8000-0000000000c3",
		updatedAt: "2026-09-10T04:03:00.000Z",
	},
	usage: {
		modelCalls: 6,
		inputTokens: 19_800,
		outputTokens: 4_800,
		totalTokens: 24_600,
		reportedCost: 0.28,
		latestContext: { usedTokens: 96_000, capacityTokens: 200_000 },
	},
	participants: [
		{ kind: "person", id: sam.id, name: sam.name, handle: handleFromName(sam.name), image: null },
		{
			kind: "agent",
			id: linear.id,
			name: linear.name,
			handle: handleFromName(linear.name),
			hue: linear.hue,
			face: linear.face,
		},
	],
	// Triager is in the pod but has not spoken: what a first mention names.
	crew: [
		{
			kind: "agent",
			id: linear.id,
			name: linear.name,
			handle: handleFromName(linear.name),
			hue: linear.hue,
			face: linear.face,
		},
		{
			kind: "agent",
			id: triager.id,
			name: triager.name,
			handle: triager.handle,
			hue: triager.hue,
			face: triager.face,
		},
	],
	olderMessagesCursor: null,
	messages: [
		{
			id: "0199a3a0-0000-7000-8000-0000000000c2",
			threadId: "0199a3a0-0000-7000-8000-0000000000c1",
			author: {
				kind: "person",
				id: sam.id,
				name: sam.name,
				handle: handleFromName(sam.name),
				image: null,
			},
			kind: "text",
			status: "complete",
			parts: [{ type: "text", text: "Draft release notes" }],
			content: "Draft release notes",
			createdAt: "2026-09-10T04:00:00.000Z",
		},
		{
			id: "0199a3a0-0000-7000-8000-0000000000c3",
			threadId: "0199a3a0-0000-7000-8000-0000000000c1",
			author: {
				kind: "agent",
				id: linear.id,
				name: linear.name,
				handle: handleFromName(linear.name),
				hue: linear.hue,
				face: linear.face,
			},
			kind: "text",
			status: "complete",
			parts: [{ type: "text", text: "The release notes are ready." }],
			content: "The release notes are ready.",
			createdAt: "2026-09-10T04:02:00.000Z",
		},
	],
};

beforeEach(apiAnswers);

afterEach(() => {
	cleanup();
	vi.clearAllMocks();
});

describe("thread navigation", () => {
	it("does not show a thread under another workspace's address", async () => {
		client.api.threads.get.mockReturnValue(
			Effect.succeed({
				...threadDetails,
				thread: { ...threadDetails.thread, workspaceId: "0199a3a0-0000-7000-8000-000000000099" },
			}),
		);
		mount(`/suga/threads/${threadDetails.thread.id}`);
		expect(await screen.findByText("No such thread here")).toBeDefined();
		expect(screen.queryByText("The release notes are ready.")).toBeNull();
	});
	it("says why a reply failed, in the provider's words", async () => {
		const failed = {
			...threadDetails,
			messages: [
				threadDetails.messages[0],
				{
					...threadDetails.messages[1],
					status: "failed" as const,
					parts: [],
					content: "",
					error: "Provider returned 403: This model requires 18+ age confirmation.",
				},
			],
		};
		client.api.threads.get.mockReturnValue(Effect.succeed(failed));
		mount(`/suga/threads/${threadDetails.thread.id}`);

		expect(await screen.findByText("Reply failed")).toBeDefined();
		expect(screen.getByText(/18\+ age confirmation/)).toBeDefined();
	});

	it("uses the thread participant as host when the workspace roster fails", async () => {
		client.api.agents.list.mockReturnValue(
			Effect.fail(new InternalServerError({ message: "Unavailable" })),
		);
		client.api.threads.get.mockReturnValue(Effect.succeed(threadDetails));

		mount(`/suga/threads/${threadDetails.thread.id}`);

		expect(await screen.findByText("The release notes are ready.")).toBeDefined();
		expect(screen.getAllByText(linear.name).length).toBeGreaterThan(0);
	});

	it("distinguishes a failed thread request from a missing thread", async () => {
		client.api.threads.get.mockReturnValue(Effect.fail(new Forbidden({ message: "Unavailable" })));

		mount(`/suga/threads/${threadDetails.thread.id}`);

		expect(await screen.findByText("Could not load this thread")).toBeDefined();
		expect(screen.queryByText("No such thread here")).toBeNull();
	});

	it("collapses and restores the wide thread summary", async () => {
		client.api.threads.get.mockReturnValue(Effect.succeed(threadDetails));
		const router = mount(`/suga/threads/${threadDetails.thread.id}`);
		await screen.findByRole("complementary", { name: "Chat summary" });

		fireEvent.click(screen.getAllByRole("button", { name: "Hide chat summary" })[0] as Element);

		expect(screen.queryByRole("complementary", { name: "Chat summary" })).toBeNull();
		await waitFor(() => expect(router.state.location.search.summary).toBe("closed"));
		fireEvent.click(screen.getByRole("button", { name: "Show chat summary" }));
		expect(await screen.findByRole("complementary", { name: "Chat summary" })).toBeDefined();
		await waitFor(() => expect(router.state.location.search.summary).toBeUndefined());
	});

	it("says the Scribe has no model, and where to set it up", async () => {
		client.api.threads.get.mockReturnValue(
			Effect.succeed({ ...threadDetails, summary: null, summaryEnabled: false }),
		);
		mount(`/suga/threads/${threadDetails.thread.id}`);

		expect(await screen.findAllByText(/The Scribe writes these/)).not.toHaveLength(0);
		expect(
			screen.getAllByRole("link", { name: "Set up the Scribe" })[0]?.getAttribute("href"),
		).toBe("/suga/settings/built-in-agents/summarise");
	});

	it("tells a member why there is no summary without a link they cannot follow", async () => {
		apiAnswers({ role: "member" });
		client.api.threads.get.mockReturnValue(
			Effect.succeed({ ...threadDetails, summary: null, summaryEnabled: false }),
		);
		mount(`/suga/threads/${threadDetails.thread.id}`);

		expect(await screen.findAllByText(/The Scribe writes these/)).not.toHaveLength(0);
		expect(screen.queryByRole("link", { name: "Set up the Scribe" })).toBeNull();
	});

	it("says nothing about setting the Scribe up when the API did not answer that", async () => {
		// `summaryEnabled` is optional: absent means the API did not say, which
		// must not read as "the Scribe is unset".
		const { summaryEnabled: _omitted, ...withoutTheField } = {
			...threadDetails,
			summary: null,
			summaryEnabled: undefined,
		};
		client.api.threads.get.mockReturnValue(Effect.succeed(withoutTheField));
		mount(`/suga/threads/${threadDetails.thread.id}`);

		expect(
			await screen.findAllByText(/A summary will appear after the first agent reply/),
		).not.toHaveLength(0);
		expect(screen.queryByRole("link", { name: "Set up the Scribe" })).toBeNull();
	});

	it("refetches a generated summary after the thread event", async () => {
		const threadUpdates = controlledEventStream();
		client.events.thread.mockReturnValue(threadUpdates.stream);
		let current: ThreadDetails = { ...threadDetails, summary: null };
		client.api.threads.get.mockImplementation(() => Effect.succeed(current));
		mount(`/suga/threads/${threadDetails.thread.id}`);
		expect(
			await screen.findAllByText("A summary will appear after the first agent reply."),
		).not.toHaveLength(0);

		current = threadDetails;
		threadUpdates.emit(streamEvent("thread.changed", { threadId: threadDetails.thread.id }));

		expect(
			await screen.findAllByText("The release notes are drafted and ready for review."),
		).not.toHaveLength(0);
	});

	it("labels missing provider cost and context capacity as unavailable", async () => {
		client.api.threads.get.mockReturnValue(
			Effect.succeed({
				...threadDetails,
				usage: {
					...threadDetails.usage,
					reportedCost: null,
					latestContext: { usedTokens: 12_400, capacityTokens: null },
				},
			}),
		);
		mount(`/suga/threads/${threadDetails.thread.id}`);

		expect((await screen.findAllByText("capacity unavailable")).length).toBeGreaterThan(0);
		expect(screen.queryByRole("progressbar", { name: "Latest turn context used" })).toBeNull();
		expect(screen.getAllByText("—").length).toBeGreaterThan(0);
	});

	it("applies streamed agent messages to the thread cache", async () => {
		const updates = controlledEventStream();
		client.events.thread.mockReturnValue(updates.stream);
		client.api.threads.get.mockReturnValue(Effect.succeed(threadDetails));
		mount(`/suga/threads/${threadDetails.thread.id}`);
		await screen.findByText("The release notes are ready.");

		const messageId = "0199a3a0-0000-7000-8000-0000000000c4";
		const created = streamEvent("message.created", {
			threadId: threadDetails.thread.id,
			message: {
				id: messageId,
				threadId: threadDetails.thread.id,
				author: {
					kind: "agent",
					id: linear.id,
					name: linear.name,
					handle: handleFromName(linear.name),
					hue: linear.hue,
					face: linear.face,
				},
				kind: "text",
				status: "streaming",
				parts: [],
				content: "",
				createdAt: "2026-09-10T04:03:00.000Z",
			},
		});
		updates.emit(created);
		updates.emit(created);
		updates.emit(
			streamEvent("message.delta", {
				threadId: threadDetails.thread.id,
				messageId,
				offset: 0,
				text: "Release checked",
			}),
		);
		updates.emit(
			streamEvent("message.completed", {
				threadId: threadDetails.thread.id,
				messageId,
				content: "Release checked",
				status: "complete",
			}),
		);

		expect(await screen.findByText("Release checked")).toBeDefined();
		expect(screen.getAllByText("Release checked")).toHaveLength(1);
		expect(await screen.findAllByText("Updating after new messages")).not.toHaveLength(0);
	});

	it("loads and deduplicates older messages while keeping live updates", async () => {
		const updates = controlledEventStream();
		client.events.thread.mockReturnValue(updates.stream);
		const cursor = "older-page";
		const [firstMessage, secondMessage] = threadDetails.messages;
		if (!firstMessage || !secondMessage) {
			throw new Error("Thread fixture is missing its conversation");
		}
		const olderMessage = {
			...firstMessage,
			id: "0199a3a0-0000-7000-8000-0000000000c0",
			content: "Earlier context",
			parts: [{ type: "text" as const, text: "Earlier context" }],
			createdAt: "2026-09-10T03:00:00.000Z",
		};
		client.api.threads.get.mockImplementation((request) =>
			Effect.succeed(
				request.query?.cursor
					? {
							...threadDetails,
							messages: [olderMessage, firstMessage],
							olderMessagesCursor: null,
						}
					: { ...threadDetails, olderMessagesCursor: cursor },
			),
		);
		mount(`/suga/threads/${threadDetails.thread.id}`);

		fireEvent.click(await screen.findByRole("button", { name: "Load older" }));

		expect(await screen.findByText("Earlier context")).toBeDefined();
		expect(screen.getAllByText("Draft release notes", { selector: "p" })).toHaveLength(1);
		expect(client.api.threads.get).toHaveBeenCalledWith({
			params: { threadId: threadDetails.thread.id },
			query: { cursor, limit: DEFAULT_THREAD_HISTORY_LIMIT },
		});

		updates.emit(
			streamEvent("message.created", {
				threadId: threadDetails.thread.id,
				message: {
					...secondMessage,
					id: "0199a3a0-0000-7000-8000-0000000000c4",
					content: "Live after paging",
					parts: [{ type: "text", text: "Live after paging" }],
					createdAt: "2026-09-10T04:03:00.000Z",
				},
			}),
		);
		expect(await screen.findByText("Live after paging")).toBeDefined();
		expect(screen.getByText("Earlier context")).toBeDefined();
	});

	it("keeps current thread metadata and messages when an older page resolves late", async () => {
		const updates = controlledEventStream();
		client.events.thread.mockReturnValue(updates.stream);
		const currentMessage = threadDetails.messages[1];
		if (!currentMessage) throw new Error("Thread fixture is missing its agent reply");
		const olderPage = pendingAnswer();
		client.api.threads.get.mockImplementation((request) =>
			request.query?.cursor
				? olderPage.effect
				: Effect.succeed({ ...threadDetails, olderMessagesCursor: "older-page" }),
		);
		mount(`/suga/threads/${threadDetails.thread.id}`);
		fireEvent.click(await screen.findByRole("button", { name: "Load older" }));

		updates.emit(
			streamEvent("message.completed", {
				threadId: threadDetails.thread.id,
				messageId: currentMessage.id,
				status: "complete",
				content: "Completed while paging",
			}),
		);
		expect(await screen.findByText("Completed while paging")).toBeDefined();

		olderPage.answer(
			Effect.succeed({
				...threadDetails,
				thread: { ...threadDetails.thread, title: "Stale page title" },
				messages: [{ ...currentMessage, content: "Stale page message" }],
				olderMessagesCursor: null,
			}),
		);

		await waitFor(() => expect(screen.queryByRole("button", { name: "Load older" })).toBeNull());
		expect(screen.getByText("Completed while paging")).toBeDefined();
		expect(screen.queryByText("Stale page message")).toBeNull();
		expect(screen.queryByText("Stale page title")).toBeNull();
	});

	it("reports a failure to load older messages", async () => {
		client.api.threads.get.mockImplementation((request) =>
			request.query?.cursor
				? Effect.fail(new InternalServerError({ message: "History unavailable" }))
				: Effect.succeed({ ...threadDetails, olderMessagesCursor: "older-page" }),
		);
		mount(`/suga/threads/${threadDetails.thread.id}`);

		fireEvent.click(await screen.findByRole("button", { name: "Load older" }));

		expect((await screen.findByRole("alert")).textContent).toContain("History unavailable");
		expect(screen.getByRole("button", { name: "Load older" }).hasAttribute("disabled")).toBe(false);
	});

	it("refetches when an event arrives before the initial thread data", async () => {
		const updates = controlledEventStream();
		client.events.thread.mockReturnValue(updates.stream);
		const initial = pendingAnswer();
		const incoming = {
			id: "0199a3a0-0000-7000-8000-0000000000c4",
			threadId: threadDetails.thread.id,
			author: {
				kind: "agent" as const,
				id: linear.id,
				name: linear.name,
				handle: handleFromName(linear.name),
				hue: linear.hue,
				face: linear.face,
			},
			kind: "text" as const,
			status: "complete" as const,
			parts: [{ type: "text" as const, text: "Arrived early" }],
			content: "Arrived early",
			createdAt: "2026-09-10T04:03:00.000Z",
		};
		client.api.threads.get
			.mockReturnValueOnce(initial.effect)
			.mockImplementation(() =>
				Effect.succeed({ ...threadDetails, messages: [...threadDetails.messages, incoming] }),
			);
		mount(`/suga/threads/${threadDetails.thread.id}`);
		await waitFor(() => expect(client.events.thread).toHaveBeenCalled());

		updates.emit(
			streamEvent("message.created", { threadId: threadDetails.thread.id, message: incoming }),
		);
		initial.answer(Effect.succeed(threadDetails));

		expect(await screen.findByText("Arrived early")).toBeDefined();
		expect(client.api.threads.get).toHaveBeenCalledTimes(2);
	});

	it("recognizes a mention before that agent has spoken", async () => {
		client.api.threads.get.mockReturnValue(
			Effect.succeed({
				...threadDetails,
				messages: [
					{
						...threadDetails.messages[1],
						parts: [{ type: "text", text: `@${triager.handle}, what do you think?` }],
						content: `@${triager.handle}, what do you think?`,
					},
				],
			}),
		);
		mount(`/suga/threads/${threadDetails.thread.id}`);

		expect((await screen.findByText(`@${triager.handle}`)).tagName).toBe("SPAN");
	});

	it("matches complete mention handles without matching prefixes or email text", async () => {
		const firstMessage = threadDetails.messages[0];
		if (!firstMessage) throw new Error("Thread fixture is missing its opening message");
		client.api.threads.get.mockReturnValue(
			Effect.succeed({
				...threadDetails,
				messages: [
					{
						...firstMessage,
						content: "Ask @linear-handler, not @linear-handler-2 or a@linear-handler",
						parts: [
							{
								type: "text",
								text: "Ask @linear-handler, not @linear-handler-2 or a@linear-handler",
							},
						],
					},
				],
			}),
		);
		mount(`/suga/threads/${threadDetails.thread.id}`);

		expect(await screen.findByText("@linear-handler", { selector: "span" })).toBeDefined();
		expect(screen.getAllByText(/@linear-handler/, { selector: "span" })).toHaveLength(1);
	});

	it("renders agent Markdown without interpreting a person's Markdown syntax", async () => {
		const [personMessage, agentMessage] = threadDetails.messages;
		if (!personMessage || !agentMessage) {
			throw new Error("Thread fixture is missing its conversation");
		}
		const asked = "Is **this** bold?";
		const answered = "**Tim's bill** is high.\n\n- Look up plans\n- Draft a note";
		client.api.threads.get.mockReturnValue(
			Effect.succeed({
				...threadDetails,
				messages: [
					{ ...personMessage, content: asked, parts: [{ type: "text", text: asked }] },
					{ ...agentMessage, content: answered, parts: [{ type: "text", text: answered }] },
				],
			}),
		);
		mount(`/suga/threads/${threadDetails.thread.id}`);

		expect((await screen.findByText("Tim's bill")).getAttribute("data-streamdown")).toBe("strong");
		expect(screen.getByText("Look up plans").tagName).toBe("LI");
		expect(screen.getByText(asked)).toBeDefined();
	});

	it("says the agent is typing from when the turn starts until its reply is finished", async () => {
		const [personMessage, agentMessage] = threadDetails.messages;
		if (!personMessage || !agentMessage) {
			throw new Error("Thread fixture is missing its conversation");
		}
		const updates = controlledEventStream();
		client.events.thread.mockReturnValue(updates.stream);
		client.api.threads.get.mockReturnValue(
			Effect.succeed({
				...threadDetails,
				thread: { ...threadDetails.thread, status: "running" },
				messages: [personMessage],
			}),
		);
		mount(`/suga/threads/${threadDetails.thread.id}`);
		expect(await screen.findByRole("status", { name: `${linear.name}, typing` })).toBeDefined();

		updates.emit(
			streamEvent("message.created", {
				threadId: threadDetails.thread.id,
				message: { ...agentMessage, status: "streaming", content: "", parts: [] },
			}),
		);

		updates.emit(
			streamEvent("message.delta", {
				threadId: threadDetails.thread.id,
				messageId: agentMessage.id,
				offset: 0,
				text: "Release ",
			}),
		);
		// One line for the whole turn, and none of the reply until it is done.
		await waitFor(() => expect(client.events.thread).toHaveBeenCalled());
		expect(screen.getAllByRole("status", { name: `${linear.name}, typing` })).toHaveLength(1);
		expect(screen.queryByText("Release")).toBeNull();

		updates.emit(
			streamEvent("message.completed", {
				threadId: threadDetails.thread.id,
				messageId: agentMessage.id,
				content: "Release notes drafted.",
				status: "complete",
			}),
		);

		expect(await screen.findByText("Release notes drafted.")).toBeDefined();
		expect(screen.queryByRole("status", { name: `${linear.name}, typing` })).toBeNull();
	});

	it("closes the thread stream when leaving the thread", async () => {
		const updates = controlledEventStream();
		client.events.thread.mockReturnValue(updates.stream);
		client.api.threads.get.mockReturnValue(Effect.succeed(threadDetails));
		const router = mount(`/suga/threads/${threadDetails.thread.id}`);
		await screen.findByText("The release notes are ready.");

		await router.navigate({
			to: "/$workspace/pods/$pod/agents/$agent",
			params: { workspace: "suga", pod: "suga-team", agent: linear.handle },
		});

		await waitFor(() => expect(updates.close).toHaveBeenCalledOnce());
	});
});
