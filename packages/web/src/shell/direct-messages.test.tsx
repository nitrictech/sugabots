import {
	type Direct,
	type DirectMessageListItem,
	type Message,
	streamEvent,
	type ThreadDetails,
} from "@sugabots/contracts";
import { NotFound } from "@sugabots/contracts/http";
import { testPerson } from "@sugabots/contracts/testing";
import { userText } from "@sugabots/errors";
import { cleanup, fireEvent, screen, waitFor, within } from "@testing-library/react";
import { Effect } from "effect";
import { afterEach, beforeEach, describe, expect, it, onTestFinished, vi } from "vitest";
import {
	apiAnswers,
	controlledEventStream,
	juno,
	linear,
	mount,
	sam,
	workspace,
} from "@/test-api.tsx";
import { client } from "@/test-client.ts";

vi.mock("@/api.ts", () => import("@/test-client.ts"));

const withJuno: Direct = {
	kind: "direct",
	id: "0199a3a0-0000-7000-8000-0000000006a1",
	workspaceId: workspace.id,
	title: "Direct message",
	createdAt: "2026-09-18T08:00:00.000Z",
	updatedAt: "2026-09-18T08:00:00.000Z",
};

const junoParticipant = testPerson({ id: juno.id, name: juno.name, email: juno.email });

const fromJuno: Message = {
	id: "0199a3a0-0000-7000-8000-0000000007a1",
	threadId: withJuno.id,
	author: junoParticipant,
	kind: "text",
	status: "complete",
	parts: [{ type: "text", text: "Lunch on Friday?" }],
	content: "Lunch on Friday?",
	createdAt: "2026-09-18T09:00:00.000Z",
};

function junoItem(unreadMessages: number): DirectMessageListItem {
	return {
		conversation: withJuno,
		people: [junoParticipant],
		formerMembers: 0,
		lastMessage: { preview: fromJuno.content, authorUserId: juno.id, at: fromJuno.createdAt },
		unreadMessages,
	};
}

/** A third person in the workspace, for a group. */
const theo = testPerson({
	id: "0199a3a0-0000-7000-8000-00000000000b",
	name: "Theo",
	email: "theo@example.com",
});

/** A group: Juno and Theo. */
const withJunoAndTheo: Direct = {
	...withJuno,
	id: "0199a3a0-0000-7000-8000-0000000006a3",
};

const groupItem: DirectMessageListItem = {
	conversation: withJunoAndTheo,
	people: [junoParticipant, theo],
	formerMembers: 0,
	lastMessage: null,
	unreadMessages: 0,
};

/** The workspace's people, Theo among them. */
function membersWithTheo() {
	return [sam, juno, theo].map((user, index) => ({
		id: `0199a3a0-0000-7000-8000-0000000000d${index + 1}`,
		role: index === 0 ? ("admin" as const) : ("member" as const),
		user: { id: user.id, name: user.name, email: user.email, image: user.image },
		joinedAt: "2026-09-10T00:00:00.000Z",
	}));
}

/** What a direct message holds, as the thread API returns it. */
function details(
	conversation: Direct,
	messages: Message[],
	others: ReturnType<typeof testPerson>[] = [junoParticipant],
): ThreadDetails {
	const me = testPerson({ id: sam.id, name: sam.name, email: sam.email });
	const people = [me, ...others];
	return {
		thread: {
			id: conversation.id,
			workspaceId: conversation.workspaceId,
			podId: null,
			hostAgentId: null,
			conversationId: conversation.id,
			type: conversation.kind,
			title: conversation.title,
			status: "done",
			parentThreadId: null,
			initiatorUserId: sam.id,
			doneAt: null,
			createdAt: conversation.createdAt,
			updatedAt: conversation.updatedAt,
		},
		capabilities: { approveToolCalls: true },
		routineExecution: null,
		startedFrom: null,
		participants: people,
		crew: [],
		members: people,
		olderMessagesCursor: null,
		queuedSince: null,
		reads: [],
		messages,
	};
}

/** Answers for the direct messages with Juno, and with Juno and Theo, Juno's message `unread` until read. */
function directMessageAnswers({ unread = 0 }: { unread?: number } = {}) {
	let unreadWithJuno = unread;
	client.api.chats.directMessages.mockImplementation(() =>
		Effect.succeed({ items: [junoItem(unreadWithJuno), groupItem] }),
	);
	client.api.chats.directMessage.mockImplementation(
		({ params }: { params: { conversationId: string } }) => {
			const item = [junoItem(unreadWithJuno), groupItem].find(
				(candidate) => candidate.conversation.id === params.conversationId,
			);
			return item
				? Effect.succeed(item)
				: Effect.fail(new NotFound({ message: userText`No such thread` }));
		},
	);
	client.api.chats.markRead.mockImplementation(
		({ params }: { params: { conversationId: string } }) => {
			if (params.conversationId === withJuno.id) unreadWithJuno = 0;
			return Effect.succeed(undefined);
		},
	);
	client.api.chats.messages.mockImplementation(
		({ params }: { params: { conversationId: string } }) =>
			Effect.succeed({
				items:
					params.conversationId === withJuno.id ? [{ kind: "message", message: fromJuno }] : [],
				nextCursor: null,
			}),
	);
	// The bots' channels as `apiAnswers` has them, and the direct messages.
	const channelOf = client.api.threads.get.getMockImplementation();
	client.api.threads.get.mockImplementation((request: { params: { threadId: string } }) => {
		const { threadId } = request.params;
		if (threadId === withJuno.id) return Effect.succeed(details(withJuno, [fromJuno]));
		if (threadId === withJunoAndTheo.id) {
			return Effect.succeed(details(withJunoAndTheo, [], [junoParticipant, theo]));
		}
		return channelOf?.(request) ?? Effect.fail(new NotFound({ message: userText`No such thread` }));
	});
	client.api.chats.sendDirectMessage.mockReturnValue(
		Effect.succeed({ conversation: withJuno, message: fromJuno }),
	);
}

function windowFocused() {
	const hasFocus = vi.spyOn(document, "hasFocus").mockReturnValue(true);
	onTestFinished(() => hasFocus.mockRestore());
}

beforeEach(() => {
	localStorage.clear();
	apiAnswers();
	directMessageAnswers();
});

afterEach(() => {
	cleanup();
	vi.clearAllMocks();
});

/** The sidebar's Direct messages. */
async function directMessagesInSidebar() {
	const sidebar = await screen.findByRole("navigation", { name: "Sidebar" });
	return within(sidebar).getByRole("region", { name: "Direct messages" });
}

describe("direct messages", () => {
	it("opens one with a person from a notification's address, by their name, at the message", async () => {
		mount(`/suga/dm/${withJuno.id}?message=${fromJuno.id}`);

		expect(await screen.findByRole("heading", { level: 1, name: juno.name })).toBeDefined();
		expect(await screen.findByText(fromJuno.content)).toBeDefined();
		expect(screen.getByRole("textbox", { name: `Message ${juno.name}` })).toBeDefined();
		expect(screen.queryByRole("button", { name: "Mark done" })).toBeNull();
	});

	it("says so when the address is of a direct message the person is not in", async () => {
		mount(`/suga/dm/${crypto.randomUUID()}`);

		expect(await screen.findByText("Conversation not found")).toBeDefined();
	});

	it("counts what is unread in the sidebar until it is read", async () => {
		windowFocused();
		directMessageAnswers({ unread: 2 });
		mount(`/suga/pods/suga-team/agents/${linear.handle}`);
		const section = await directMessagesInSidebar();
		const row = await within(section).findByRole("link", { name: /^Juno(?!,)/ });
		expect(row.textContent).toContain("2 unread messages");

		fireEvent.click(row);

		await waitFor(() =>
			expect(client.api.chats.markRead).toHaveBeenCalledWith({
				params: { conversationId: withJuno.id },
			}),
		);
		await waitFor(() =>
			expect(within(section).getByRole("link", { name: /^Juno(?!,)/ }).textContent).not.toContain(
				"unread",
			),
		);
		expect(
			within(section)
				.getByRole("link", { name: /^Juno(?!,)/ })
				.getAttribute("aria-current"),
		).toBe("page");
	});

	it("lists a new one as soon as the workspace's events say it changed", async () => {
		const updates = controlledEventStream();
		client.events.workspace.mockReturnValue(updates.stream);
		client.api.chats.directMessages.mockReturnValue(Effect.succeed({ items: [] }));
		mount(`/suga/pods/suga-team/agents/${linear.handle}`);
		const section = await directMessagesInSidebar();
		await within(section).findByRole("link", { name: "New message" });

		client.api.chats.directMessages.mockReturnValue(Effect.succeed({ items: [junoItem(1)] }));
		updates.emit(streamEvent("thread.changed", { threadId: withJuno.id }));

		expect(await within(section).findByRole("link", { name: /^Juno(?!,)/ })).toBeDefined();
	});

	it("chooses people in New message, suggesting people rather than groups, and writes in the conversation already with them", async () => {
		client.api.workspaces.members.mockReturnValue(Effect.succeed(membersWithTheo()));
		client.api.chats.directMessages.mockReturnValue(
			Effect.succeed({ items: [junoItem(0), groupItem] }),
		);
		client.api.chats.send.mockReturnValue(
			Effect.succeed({ message: fromJuno, routing: { status: "routed" } }),
		);
		const threadOf = client.api.threads.get.getMockImplementation();
		client.api.threads.get.mockImplementation((request: { params: { threadId: string } }) =>
			request.params.threadId === withJunoAndTheo.id
				? Effect.succeed(details(withJunoAndTheo, [], [junoParticipant, theo]))
				: threadOf?.(request),
		);
		const router = mount(`/suga/pods/suga-team/agents/${linear.handle}`);
		const section = await directMessagesInSidebar();
		fireEvent.click(within(section).getByRole("link", { name: "New message" }));

		const suggestions = await screen.findByRole("listbox", { name: "Suggestions" });
		await within(suggestions).findByRole("option", { name: /^Theo/ });
		// Juno once, though there are direct messages with Juno alone and with Juno and Theo; never you, nor a bot.
		expect(within(suggestions).getAllByRole("option", { name: /Juno/ })).toHaveLength(1);
		expect(within(suggestions).queryByRole("option", { name: "Juno, Theo" })).toBeNull();
		expect(within(suggestions).queryByRole("option", { name: new RegExp(sam.name) })).toBeNull();
		expect(within(suggestions).queryByRole("option", { name: new RegExp(linear.name) })).toBeNull();

		fireEvent.click(within(suggestions).getByRole("option", { name: /^Juno/ }));
		// Choosing somebody closes the suggestions until the next name is typed.
		expect(screen.queryByRole("option")).toBeNull();
		fireEvent.change(screen.getByRole("combobox"), { target: { value: "Th" } });
		fireEvent.click(await screen.findByRole("option", { name: /^Theo/ }));
		const recipients = screen.getByRole("list", { name: "Recipients" });
		expect(within(recipients).getAllByRole("listitem")).toHaveLength(2);
		expect(within(recipients).getByRole("button", { name: "Remove Juno" })).toBeDefined();
		expect(within(recipients).getByRole("button", { name: "Remove Theo" })).toBeDefined();
		// They have a conversation already, which shows in place of a new one.
		const composer = await screen.findByLabelText("Message Juno and Theo", {}, { timeout: 5_000 });
		composer.textContent = "Lunch on Friday?";
		fireEvent.input(composer);
		fireEvent.click(screen.getByRole("button", { name: "Send message" }));

		await waitFor(() =>
			expect(router.state.location.pathname).toBe(`/suga/dm/${withJunoAndTheo.id}`),
		);
		expect(client.api.chats.send).toHaveBeenCalledWith({
			params: { conversationId: withJunoAndTheo.id },
			payload: { id: expect.any(String), message: "Lunch on Friday?" },
		});
		expect(client.api.chats.sendDirectMessage).not.toHaveBeenCalled();
		expect(await screen.findByRole("heading", { level: 1, name: "Juno and Theo" })).toBeDefined();
	});

	it("sends to somebody with no conversation yet, and opens the one it starts with nothing left to send", async () => {
		const updates = controlledEventStream();
		client.events.workspace.mockReturnValue(updates.stream);
		client.api.chats.directMessages.mockReturnValue(Effect.succeed({ items: [] }));
		let answer: () => void = () => {};
		const answered = new Promise<void>((resolve) => {
			answer = resolve;
		});
		client.api.chats.sendDirectMessage.mockReturnValue(
			Effect.promise(() => answered.then(() => ({ conversation: withJuno, message: fromJuno }))),
		);
		mount("/suga/dm/new");
		fireEvent.click(await screen.findByRole("option", { name: /^Juno/ }));
		const draft = await screen.findByLabelText("Message Juno");
		draft.textContent = "Lunch on Friday?";
		fireEvent.input(draft);

		fireEvent.click(screen.getByRole("button", { name: "Send message" }));
		// The conversation it starts is listed before the answer to sending arrives.
		client.api.chats.directMessages.mockReturnValue(Effect.succeed({ items: [junoItem(0)] }));
		updates.emit(streamEvent("thread.changed", { threadId: withJuno.id }));
		await within(await directMessagesInSidebar()).findByRole("link", { name: /^Juno/ });
		answer();

		expect(
			await screen.findByRole("heading", { level: 1, name: juno.name }, { timeout: 5_000 }),
		).toBeDefined();
		expect(await screen.findByText(fromJuno.content)).toBeDefined();
		expect(screen.getByLabelText("Message Juno").textContent).toBe("");
	});

	it("keeps what was written when it could not be sent", async () => {
		client.api.chats.directMessages.mockReturnValue(Effect.succeed({ items: [] }));
		client.api.chats.sendDirectMessage.mockReturnValue(
			Effect.fail(new NotFound({ message: userText`No such member` })),
		);
		mount("/suga/dm/new");
		fireEvent.click(await screen.findByRole("option", { name: /^Juno/ }));
		const draft = await screen.findByLabelText("Message Juno");
		draft.textContent = "Lunch on Friday?";
		fireEvent.input(draft);

		fireEvent.click(screen.getByRole("button", { name: "Send message" }));

		expect(await screen.findByText(/Message not sent/)).toBeDefined();
		expect(screen.getByLabelText("Message Juno").textContent).toBe("Lunch on Friday?");
	});

	it("takes what was written in New message to the conversation already with the person chosen", async () => {
		client.api.chats.directMessages.mockReturnValue(Effect.succeed({ items: [junoItem(0)] }));
		mount("/suga/dm/new");
		await within(await directMessagesInSidebar()).findByRole("link", { name: /^Juno/ });
		const draft = await screen.findByLabelText("Start a new message");
		draft.textContent = "About Friday";
		fireEvent.input(draft);

		fireEvent.click(await screen.findByRole("option", { name: /^Juno/ }));

		await screen.findByRole("log", { name: "Chat messages" }, { timeout: 5_000 });
		expect(screen.getByLabelText("Message Juno").textContent).toBe("About Friday");
	});

	it("takes what was written to the conversation already with the person chosen, when it loads after", async () => {
		let listLoaded: () => void = () => {};
		const loaded = new Promise<void>((resolve) => {
			listLoaded = resolve;
		});
		client.api.chats.directMessages.mockReturnValue(
			Effect.promise(() => loaded.then(() => ({ items: [junoItem(0)] }))),
		);
		mount("/suga/dm/new");
		fireEvent.click(await screen.findByRole("option", { name: /^Juno/ }));
		const draft = await screen.findByLabelText("Message Juno");
		draft.textContent = "About Friday";
		fireEvent.input(draft);

		listLoaded();

		await screen.findByRole("log", { name: "Chat messages" }, { timeout: 5_000 });
		expect(screen.getByLabelText("Message Juno").textContent).toBe("About Friday");
	});

	it("stops saying the conversation in New message is being looked at while suggestions cover it", async () => {
		windowFocused();
		client.api.chats.directMessages.mockReturnValue(Effect.succeed({ items: [junoItem(0)] }));
		mount("/suga/dm/new");
		await within(await directMessagesInSidebar()).findByRole("link", { name: /^Juno/ });
		fireEvent.click(await screen.findByRole("option", { name: /^Juno/ }));
		await screen.findByRole("log", { name: "Chat messages" }, { timeout: 5_000 });
		const lookingAt = () =>
			client.api.notifications.reportPresence.mock.lastCall?.[0].payload.conversationId;
		await waitFor(() => expect(lookingAt()).toBe(withJuno.id));

		fireEvent.change(screen.getByRole("combobox"), { target: { value: "Th" } });

		await waitFor(() => expect(lookingAt()).toBeNull());
	});

	it("leaves a conversation's own draft in it when the person chosen changes", async () => {
		localStorage.setItem(`sugabots-draft:${sam.id}:${withJuno.id}`, "Call me back");
		mount("/suga/dm/new");
		await within(await directMessagesInSidebar()).findByRole("link", { name: /^Juno(?!,)/ });
		fireEvent.click(await screen.findByRole("option", { name: /^Juno/ }));
		expect((await screen.findByLabelText("Message Juno")).textContent).toBe("Call me back");

		fireEvent.click(screen.getByRole("button", { name: "Remove Juno" }));

		expect((await screen.findByLabelText("Start a new message")).textContent).toBe("");
		expect(localStorage.getItem(`sugabots-draft:${sam.id}:${withJuno.id}`)).toBe("Call me back");
	});

	it("does not show one from another of the person's workspaces in this one's place", async () => {
		// This workspace's list does not have it.
		client.api.chats.directMessages.mockReturnValue(Effect.succeed({ items: [] }));
		client.api.chats.directMessage.mockReturnValue(
			Effect.succeed({
				...junoItem(0),
				conversation: { ...withJuno, workspaceId: "0199a3a0-0000-7000-8000-0000000000ff" },
			}),
		);
		mount(`/suga/dm/${withJuno.id}`);

		expect(await screen.findByText("Conversation not found")).toBeDefined();
		expect(screen.queryByRole("textbox", { name: `Message ${juno.name}` })).toBeNull();
	});

	it("offers the people in it to mention, but no @here or @channel, as everybody is told anyway", async () => {
		mount(`/suga/dm/${withJunoAndTheo.id}`);
		const composer = await screen.findByLabelText("Message Juno and Theo");
		composer.textContent = "@";
		fireEvent.input(composer);

		const list = within(await screen.findByRole("listbox"));
		expect(list.getByRole("option", { name: /Juno/ })).toBeDefined();
		expect(list.getByRole("option", { name: /Theo/ })).toBeDefined();
		expect(list.queryByRole("option", { name: /@here|@channel/ })).toBeNull();
	});

	it("names the people in the one open as the list does, as it changes", async () => {
		const updates = controlledEventStream();
		client.events.workspace.mockReturnValue(updates.stream);
		mount(`/suga/dm/${withJunoAndTheo.id}`);
		expect(await screen.findByRole("heading", { level: 1, name: "Juno and Theo" })).toBeDefined();

		const renamed = { ...theo, name: "Theodore" };
		client.api.chats.directMessages.mockReturnValue(
			Effect.succeed({
				items: [junoItem(0), { ...groupItem, people: [junoParticipant, renamed] }],
			}),
		);
		updates.emit(streamEvent("thread.changed", { threadId: withJunoAndTheo.id }));

		expect(
			await screen.findByRole("heading", { level: 1, name: "Juno and Theodore" }),
		).toBeDefined();
	});

	it("marks New message in the sidebar while it is open", async () => {
		mount("/suga/dm/new");

		const section = await directMessagesInSidebar();
		expect(
			(await within(section).findByRole("link", { name: "New message" })).getAttribute(
				"aria-current",
			),
		).toBe("page");
	});

	it("lists who is in a group, and offers no way to add anybody", async () => {
		mount(`/suga/dm/${withJunoAndTheo.id}`);

		fireEvent.click(await screen.findByRole("button", { name: /^3 members/ }));

		const members = await screen.findByRole("list", { name: "Members" });
		expect(within(members).getByText("Juno")).toBeDefined();
		expect(within(members).getByText("Theo")).toBeDefined();
		expect(within(members).getByText("You")).toBeDefined();
		expect(screen.queryByRole("link", { name: "Add people" })).toBeNull();
	});

	it("opens a person's message from Inbox in their direct message", async () => {
		client.api.chats.activity.mockReturnValue(
			Effect.succeed({
				items: [
					{
						kind: "message",
						messageId: fromJuno.id,
						author: junoParticipant,
						preview: fromJuno.content,
						podId: null,
						conversationId: withJuno.id,
						at: fromJuno.createdAt,
						unread: true,
					},
				],
			}),
		);
		mount("/suga/activity");

		const row = await screen.findByRole("link", {
			name: new RegExp(`${juno.name} wrote.*in a direct message`),
		});
		expect(row.getAttribute("href")).toBe(`/suga/dm/${withJuno.id}?message=${fromJuno.id}`);
	});

	it("counts every unread message in its direct messages as written to the person, as a mention is", async () => {
		directMessageAnswers({ unread: 2 });
		// The activity feed holds the latest items only, so it is not where they are counted.
		client.api.chats.activity.mockReturnValue(Effect.succeed({ items: [] }));
		mount(`/suga/dm/${withJunoAndTheo.id}`);

		const sidebar = await screen.findByRole("navigation", { name: "Sidebar" });
		expect(await within(sidebar).findByText("2 unread messages for you")).toBeDefined();
	});

	it("marks every direct message with anything unread read from Inbox, past what Inbox lists", async () => {
		directMessageAnswers({ unread: 1 });
		client.api.chats.activity.mockReturnValue(Effect.succeed({ items: [] }));
		mount("/suga/activity");

		fireEvent.click(await screen.findByRole("button", { name: "Mark all as read" }));

		await waitFor(() =>
			expect(client.api.chats.markRead).toHaveBeenCalledWith({
				params: { conversationId: withJuno.id },
			}),
		);
	});
});
