import type { Message, ThreadDetails } from "@sugabots/contracts";
import { testPerson } from "@sugabots/contracts/testing";
import { delay, HttpResponse, http } from "msw";
import { expect, screen, userEvent, waitFor, within } from "storybook/test";
import preview from "#storybook/preview";
import {
	accountManager,
	chief,
	growthDesk,
	linearHandler,
	revenue,
} from "@/shell/story-fixtures.ts";
import {
	appHandlers,
	chatPath,
	StoryApp,
	storyBots,
	storyChatDetails,
	storyConversationFor,
	storyPodChatFor,
	storyUser,
	storyWorkspace,
} from "../story-app.tsx";

/*
 * A bot's chat as the app shows it: the rail and the pod's list beside it, the
 * header across the top, and the thread with its composer. On a phone the chat
 * takes the screen, its header centred, with Back to the list.
 */

function said(id: string, by: "you" | "bot", text: string, at: string): Message {
	const thread = storyConversationFor(growthDesk).id;
	return {
		id: `0199a3a0-0000-7000-8000-0000000005${id}`,
		threadId: thread,
		author:
			by === "you"
				? testPerson({ id: storyUser.id, name: storyUser.name })
				: {
						kind: "agent",
						id: growthDesk.id,
						name: growthDesk.name,
						handle: growthDesk.handle,
						color: growthDesk.color,
						face: growthDesk.face,
						shape: growthDesk.shape,
					},
		kind: "text",
		status: "complete",
		parts: [{ type: "text", text }],
		content: text,
		createdAt: at,
	};
}

const conversation: Message[] = [
	said(
		"01",
		"bot",
		"Overnight outbound queued 38 leads and six have already replied.",
		"2026-09-18T06:04:00.000Z",
	),
	said(
		"02",
		"bot",
		"The two Northwind accounts both asked for pricing. Want me to draft replies?",
		"2026-09-18T06:04:30.000Z",
	),
	said("03", "you", "Yes please. Keep them short.", "2026-09-18T06:06:00.000Z"),
	said(
		"04",
		"bot",
		"Drafted both. They're in your outbox for a last look.",
		"2026-09-18T06:07:00.000Z",
	),
];

const meta = preview.meta({
	title: "Views/Chat",
	tags: ["ai-generated"],
	parameters: { layout: "fullscreen" },
	beforeEach({ msw }) {
		msw.use(...appHandlers({ messages: { [growthDesk.id]: conversation } }));
	},
	render: () => <StoryApp path={chatPath(growthDesk)} />,
});

/** The chat beside its pod's list, with Details a tap on the header away. */
export const Conversation = meta.story({
	play: async ({ canvas }) => {
		const log = await canvas.findByRole("log", { name: "Chat messages" }, { timeout: 10_000 });
		await expect(await within(log).findByText(/Drafted both/)).toBeInTheDocument();
		await expect(
			canvas.getByRole("heading", { name: `Conversation with ${growthDesk.name}`, level: 1 }),
		).toBeInTheDocument();
		await expect(canvas.getByRole("button", { name: "Mark done" })).toBeInTheDocument();
	},
});

/** A shared pod opened from the rail opens its chat. */
export const PodOpensTopChat = meta.story({
	render: () => <StoryApp path={`/${storyWorkspace.slug}/pods/${revenue.slug}`} />,
	play: async ({ canvas }) => {
		await expect(
			await canvas.findByRole("heading", { name: "Pod chat", level: 1 }, { timeout: 10_000 }),
		).toBeInTheDocument();
		const list = canvas.getByRole("region", { name: revenue.name });
		await expect(within(list).getByRole("link", { name: /Pod chat/ })).toHaveAttribute(
			"aria-current",
			"page",
		);
	},
});

/** The pod's people, writing to each other: a chat with no bot in it, addressed to the pod. */
const podChat: Message[] = [
	{
		...said(
			"21",
			"you",
			"Northwind signed. Thanks for the push, everyone.",
			"2026-09-18T06:12:00.000Z",
		),
		threadId: storyPodChatFor(revenue).id,
	},
	{
		...said("22", "you", "Drinks on Friday?", "2026-09-18T06:13:00.000Z"),
		threadId: storyPodChatFor(revenue).id,
		author: testPerson({ id: "0199a3a0-0000-7000-8000-000000000012", name: "Jay Young" }),
	},
];

/** A pod's chat: everyone in the pod, no bot, and a composer addressed to the pod. */
export const PodChat = meta.story({
	beforeEach({ msw }) {
		msw.use(...appHandlers({ podChatMessages: { [revenue.id]: podChat } }));
	},
	render: () => <StoryApp path={`/${storyWorkspace.slug}/pods/${revenue.slug}/chat`} />,
	play: async ({ canvas }) => {
		const log = await canvas.findByRole("log", { name: "Chat messages" }, { timeout: 10_000 });
		await expect(await within(log).findByText(/Drinks on Friday/)).toBeInTheDocument();
		await expect(
			canvas.getByText(`Everyone in ${revenue.name}. Mention a bot to start a thread with it.`),
		).toBeInTheDocument();
		await expect(
			canvas.getByRole("textbox", { name: `Message ${revenue.name}` }),
		).toBeInTheDocument();
		await expect(canvas.queryByRole("button", { name: "Details" })).toBeNull();
	},
});

/**
 * A thread started from a message sits under it as a collaboration does, with
 * the faces of who started it and its bot, when it last moved and how many
 * replies it has. Naming a bot in the draft says sending starts a thread with it.
 */
export const PodChatStartsAThread = meta.story({
	beforeEach({ msw }) {
		msw.use(
			...appHandlers({
				podChatMessages: { [revenue.id]: podChat },
				podChatThreads: {
					[revenue.id]: [
						{
							kind: "thread",
							id: "0199a3a0-0000-7000-8000-00000000c991",
							threadId: "0199a3a0-0000-7000-8000-00000000c991",
							originMessageId: podChat[0]?.id ?? null,
							title: "Pricing for the Northwind renewal",
							agent: {
								kind: "agent",
								id: growthDesk.id,
								name: growthDesk.name,
								handle: growthDesk.handle,
								color: growthDesk.color,
								face: growthDesk.face,
								shape: growthDesk.shape,
							},
							replies: 3,
							lastReplyAt: "2026-09-18T06:20:00.000Z",
							createdAt: "2026-09-18T06:14:00.000Z",
						},
					],
				},
			}),
		);
	},
	render: () => <StoryApp path={`/${storyWorkspace.slug}/pods/${revenue.slug}/chat`} />,
	play: async ({ canvas, userEvent }) => {
		const log = await canvas.findByRole("log", { name: "Chat messages" }, { timeout: 10_000 });
		const thread = within(log).getByRole("button", {
			name: /^Open thread: Pricing for the Northwind renewal/,
		});
		await expect(thread).toHaveTextContent("Pricing for the Northwind renewal");
		await expect(thread).toHaveTextContent("Last reply");
		await expect(thread).toHaveTextContent("3 replies");
		// Under the message it was started from, before the next one.
		const started = within(log).getByText("Northwind signed. Thanks for the push, everyone.");
		const next = within(log).getByText("Drinks on Friday?");
		await expect(
			started.compareDocumentPosition(thread) & Node.DOCUMENT_POSITION_FOLLOWING,
		).toBeTruthy();
		await expect(
			thread.compareDocumentPosition(next) & Node.DOCUMENT_POSITION_FOLLOWING,
		).toBeTruthy();
		await expect(canvas.getByText("Mention a bot to start a thread.")).toBeInTheDocument();
		await userEvent.type(
			canvas.getByRole("textbox", { name: `Message ${revenue.name}` }),
			`@${growthDesk.handle} draft the renewal note with @${accountManager.handle} `,
		);
		// The first bot named is the one the thread is with; the other is only mentioned.
		await expect(canvas.getByText(`Thread with ${growthDesk.name}`)).toBeInTheDocument();
		await expect(
			canvas.getByText(`Sending starts a thread with ${growthDesk.name}.`),
		).toBeInTheDocument();
	},
});

/** Starting a thread from its first message, with a chip for each of the pod's bots. */
export const NewThread = meta.story({
	render: () => <StoryApp path={`/${storyWorkspace.slug}/pods/${revenue.slug}/threads/new`} />,
	play: async ({ canvas, userEvent }) => {
		await canvas.findByRole(
			"heading",
			{ name: `New thread in ${revenue.name}`, level: 2 },
			{ timeout: 10_000 },
		);
		await userEvent.click(await canvas.findByRole("button", { name: growthDesk.name }));
		await expect(canvas.getByText(`Thread with ${growthDesk.name}`)).toBeInTheDocument();
	},
});

const failingRoutine = {
	id: "0199a3a0-0000-7000-8000-0000000003b1",
	feed: "0199a3a0-0000-7000-8000-0000000003b2",
	runs: ["0199a3a0-0000-7000-8000-0000000003b3", "0199a3a0-0000-7000-8000-0000000003b4"],
};

/**
 * A routine whose last two runs failed: each says why, the latest offers
 * Retry and the way to fix its connection, and a line says it paused itself.
 */
export const FailingRoutine = meta.story({
	beforeEach({ msw }) {
		const feed = {
			...storyChatDetails(growthDesk),
			thread: {
				...storyChatDetails(growthDesk).thread,
				id: failingRoutine.feed,
				conversationId: failingRoutine.feed,
				type: "routine_feed" as const,
				title: "Overnight outbound",
			},
			routine: {
				id: failingRoutine.id,
				agentId: growthDesk.id,
				state: "paused" as const,
				failed: true,
				pausedAfterFailures: true,
			},
		};
		const run = (id: string, at: string) => ({
			kind: "routine",
			id,
			threadId: id,
			routineName: "Overnight outbound",
			triggerKind: "cron",
			state: "failed",
			error: "Gmail refused the connection: the token has expired.",
			createdAt: at,
		});
		msw.use(
			http.get(`${API}/threads/${failingRoutine.feed}`, () => HttpResponse.json(feed)),
			http.get(`${API}/conversations/${failingRoutine.feed}/messages`, () =>
				HttpResponse.json({
					items: [
						run(failingRoutine.runs[0] as string, "2026-09-17T06:00:00.000Z"),
						run(failingRoutine.runs[1] as string, "2026-09-18T06:00:00.000Z"),
						{
							kind: "routine_paused",
							id: failingRoutine.id,
							createdAt: "2026-09-18T06:01:00.000Z",
						},
					],
					nextCursor: null,
				}),
			),
			...appHandlers(),
		);
	},
	render: () => (
		<StoryApp
			path={`/${storyWorkspace.slug}/pods/${revenue.slug}/threads/${failingRoutine.feed}`}
		/>
	),
	play: async ({ canvas }) => {
		const log = await canvas.findByRole("log", { name: "Chat messages" }, { timeout: 10_000 });
		const failures = await within(log).findAllByRole("article", { name: /Run failed/ });
		await expect(failures).toHaveLength(2);
		await expect(
			within(failures[0] as HTMLElement).queryByRole("button", { name: "Retry" }),
		).toBeNull();
		await expect(
			within(failures[1] as HTMLElement).getByRole("button", { name: "Retry" }),
		).toBeVisible();
		await expect(
			within(log).getByText("Paused after two failed runs in a row."),
		).toBeInTheDocument();
		await expect(canvas.getByRole("button", { name: "Resume" })).toBeVisible();
	},
});

/** On a phone the pod's chat takes the screen, with Back to the pod's list. */
export const PodChatOnAPhone = meta.story({
	globals: { viewport: { value: "iphone12", isRotated: false } },
	beforeEach({ msw }) {
		msw.use(...appHandlers({ podChatMessages: { [revenue.id]: podChat } }));
	},
	render: () => <StoryApp path={`/${storyWorkspace.slug}/pods/${revenue.slug}/chat`} />,
	play: async ({ canvas }) => {
		await expect(
			await canvas.findByRole("link", { name: `Back to ${revenue.name}` }, { timeout: 10_000 }),
		).toBeVisible();
	},
});

/** On a phone the pod's list is the page, so it stays open on the list. */
export const PodOnAPhone = meta.story({
	globals: { viewport: { value: "iphone12", isRotated: false } },
	render: () => <StoryApp path={`/${storyWorkspace.slug}/pods/${revenue.slug}`} />,
	play: async ({ canvas }) => {
		await expect(
			await canvas.findByRole("link", { name: new RegExp(growthDesk.name) }, { timeout: 10_000 }),
		).toBeVisible();
		await expect(canvas.queryByRole("log", { name: "Chat messages" })).toBeNull();
	},
});

/** A bot nobody has written to yet: the start of the chat, with its face and name. */
export const FirstMessage = meta.story({
	render: () => <StoryApp path={chatPath(chief)} />,
	play: async ({ canvas }) => {
		await expect(
			await canvas.findByText(
				`This is the start of your conversation with ${chief.name}.`,
				{ exact: false },
				{ timeout: 10_000 },
			),
		).toBeInTheDocument();
	},
});

/** On a phone: the chat alone, its header centred, and Back to the pod's list. */
export const Phone = meta.story({
	globals: { viewport: { value: "iphone12", isRotated: false } },
	play: async ({ canvas }) => {
		await expect(
			await canvas.findByRole("link", { name: "Back to Revenue" }, { timeout: 10_000 }),
		).toBeInTheDocument();
	},
});

/**
 * Reply on a message's hover toolbar starts a reply: the composer names the
 * message it answers, and the message is sent quoting it.
 */
export const ReplyToAMessage = meta.story({
	beforeEach({ msw }) {
		// What is sent stays in the chat, as the API keeps it, so it is there once the chat reloads.
		const chat = [...conversation];
		msw.use(
			...appHandlers({ messages: { [growthDesk.id]: chat } }),
			http.post(`${API}/conversations/:conversationId/messages`, async ({ request }) => {
				const sent = (await request.json()) as { id: string; message: string; replyTo?: string };
				const quoted = conversation.find((message) => message.id === sent.replyTo);
				const reply: Message = {
					...said("10", "you", sent.message, "2026-09-18T06:08:00.000Z"),
					id: sent.id,
					...(quoted && {
						replyTo: { id: quoted.id, author: quoted.author, preview: quoted.content },
					}),
				};
				chat.push(reply);
				return HttpResponse.json(reply, { status: 201 });
			}),
		);
	},
	play: async ({ canvas }) => {
		const log = await canvas.findByRole("log", { name: "Chat messages" }, { timeout: 10_000 });
		const asked = (await within(log).findByText(/Want me to draft replies/)).closest("article");
		if (!asked) throw new Error("The bot's question is not a message row");
		within(asked).getByRole("button", { name: "Reply" }).focus();
		await userEvent.keyboard("{Enter}");
		const composer = canvas.getByRole("textbox", { name: `Message ${growthDesk.name}` });
		await expect(composer).toHaveFocus();
		await expect(canvas.getByRole("button", { name: "Cancel reply" })).toBeVisible();

		await userEvent.keyboard("Only the Northwind one{Enter}");
		// Look the quote up each time: the row shown while the message sends is
		// replaced when the chat reloads, and the new one rises into place.
		await waitFor(() =>
			expect(
				within(log).getByRole("button", {
					name: /^Replying to Growth Desk: The two Northwind accounts/,
				}),
			).toBeVisible(),
		);
		await expect(canvas.queryByRole("button", { name: "Cancel reply" })).toBeNull();
	},
});

/**
 * Reacting from a message's hover toolbar: the emoji shows under it at once
 * as yours, and clicking it takes it back.
 */
export const ReactToAMessage = meta.story({
	beforeEach({ msw }) {
		msw.use(...reactionHandlers(conversation.map((message) => ({ ...message }))));
	},
	play: async ({ canvas }) => {
		const log = await canvas.findByRole("log", { name: "Chat messages" }, { timeout: 10_000 });
		const asked = (await within(log).findByText(/Want me to draft replies/)).closest("article");
		if (!asked) throw new Error("The bot's question is not a message row");
		within(asked).getByRole("button", { name: "Add reaction" }).focus();
		await userEvent.keyboard("{Enter}");
		const picker = await screen.findByRole("dialog", { name: "Add reaction" });
		await waitFor(() =>
			expect(within(picker).getByRole("searchbox", { name: "Search emoji" })).toHaveFocus(),
		);
		await userEvent.keyboard("hundred points");
		// The search's only result is active once it applies, and Enter chooses it. A
		// click could miss, as the picker lays its rows out again while results arrive.
		await waitFor(
			() =>
				expect(within(picker).getByRole("gridcell", { name: "Hundred points" })).toHaveAttribute(
					"aria-selected",
					"true",
				),
			{ timeout: 5_000 },
		);
		await userEvent.keyboard("{Enter}");

		const mine = await within(asked).findByRole("button", {
			name: "💯 1: You reacted with 💯",
		});
		await expect(mine).toHaveAttribute("aria-pressed", "true");
		await userEvent.click(mine);
		await waitFor(() =>
			expect(within(asked).queryByRole("list", { name: "Reactions" })).toBeNull(),
		);
	},
});

/**
 * The chat's handlers, with reactions kept on its messages as the API keeps
 * them, so a reload still has them. A reaction added is answered after
 * `addedAfterMs`.
 */
function reactionHandlers(chat: Message[], { addedAfterMs = 0 } = {}) {
	const you = { id: storyUser.id, name: storyUser.name, at: "2026-09-18T06:09:00.000Z" };
	const change = (messageId: string, emoji: string, reacting: boolean) => {
		const index = chat.findIndex(({ id }) => id === messageId);
		const message = chat[index];
		if (!message) return HttpResponse.json([]);
		const others = (message.reactions ?? []).map((reaction) =>
			reaction.emoji === emoji
				? { ...reaction, people: reaction.people.filter(({ id }) => id !== you.id) }
				: reaction,
		);
		const reactions = reacting
			? others.some((reaction) => reaction.emoji === emoji)
				? others.map((reaction) =>
						reaction.emoji === emoji
							? { ...reaction, people: [...reaction.people, you] }
							: reaction,
					)
				: [...others, { emoji, people: [you] }]
			: others.filter((reaction) => reaction.people.length > 0);
		chat[index] = { ...message, reactions: reactions.length > 0 ? reactions : undefined };
		return HttpResponse.json(reactions);
	};
	return [
		...appHandlers({ messages: { [growthDesk.id]: chat } }),
		http.put(`${API}/messages/:messageId/reactions/:emoji`, async ({ params }) => {
			await delay(addedAfterMs);
			return change(String(params.messageId), String(params.emoji), true);
		}),
		http.delete(`${API}/messages/:messageId/reactions/:emoji`, ({ params }) =>
			change(String(params.messageId), String(params.emoji), false),
		),
	];
}

/**
 * Reactions are sent in the order they were made, so clicking one on and
 * straight off again leaves it off, however slowly the API answers the first.
 */
export const ChangeYourMindQuickly = meta.story({
	beforeEach({ msw }) {
		const jay = {
			id: "0199a3a0-0000-7000-8000-0000000005f1",
			name: "Jay Park",
			at: "2026-09-18T06:08:00.000Z",
		};
		const chat = conversation.map((message) =>
			/Want me to draft replies/.test(message.content)
				? { ...message, reactions: [{ emoji: "👍", people: [jay] }] }
				: { ...message },
		);
		msw.use(...reactionHandlers(chat, { addedAfterMs: 300 }));
	},
	play: async ({ canvas }) => {
		const log = await canvas.findByRole("log", { name: "Chat messages" }, { timeout: 10_000 });
		const asked = (await within(log).findByText(/Want me to draft replies/)).closest("article");
		if (!asked) throw new Error("The bot's question is not a message row");
		const thumbs = within(asked).getByRole("button", { name: /^👍/ });
		await userEvent.click(thumbs);
		await expect(thumbs).toHaveAccessibleName("👍 2: Jay Park and You reacted with 👍");
		await userEvent.click(thumbs);
		await expect(thumbs).toHaveAccessibleName("👍 1: Jay Park reacted with 👍");
		// Past the slow answer to the first click, and the second's after it.
		await new Promise((resolve) => setTimeout(resolve, 600));
		await expect(thumbs).toHaveAccessibleName("👍 1: Jay Park reacted with 👍");
		await expect(thumbs).toHaveAttribute("aria-pressed", "false");
	},
});

/** Details open beside the chat: the bot's card, summary, who has written and what it can use. */
export const Details = meta.story({
	play: async ({ canvas }) => {
		await userEvent.click(
			await canvas.findByRole("button", { name: "Details" }, { timeout: 10_000 }),
		);
		await expect(await canvas.findByRole("complementary", { name: "Details" })).toBeInTheDocument();
	},
});

/** On a phone, tapping the bot's name opens Details over the whole screen, header and all. */
export const DetailsOnAPhone = meta.story({
	globals: { viewport: { value: "iphone12", isRotated: false } },
	play: async ({ canvas }) => {
		await userEvent.click(
			await canvas.findByRole("button", { name: growthDesk.name }, { timeout: 10_000 }),
		);
		await expect(await canvas.findByRole("complementary", { name: "Details" })).toBeInTheDocument();
	},
});

/** On a tablet there is no room beside the chat, so Details slides over it from the right. */
export const DetailsOnATablet = meta.story({
	globals: { viewport: { value: "ipad11p", isRotated: false } },
	play: async ({ canvas }) => {
		await userEvent.click(
			await canvas.findByRole("button", { name: "Details" }, { timeout: 10_000 }),
		);
		await expect(await canvas.findByRole("complementary", { name: "Details" })).toBeInTheDocument();
		await expect(canvas.getByRole("log", { name: "Chat messages" })).toBeInTheDocument();
	},
});

const API = import.meta.env.VITE_API_URL as string;
const collaborationId = "0199a3a0-0000-7000-8000-000000000591";

const asker = {
	kind: "agent" as const,
	id: growthDesk.id,
	name: growthDesk.name,
	handle: growthDesk.handle,
	color: growthDesk.color,
	face: growthDesk.face,
	shape: growthDesk.shape,
};
const asked = {
	kind: "agent" as const,
	id: linearHandler.id,
	name: linearHandler.name,
	handle: linearHandler.handle,
	color: linearHandler.color,
	face: linearHandler.face,
	shape: linearHandler.shape,
};

/** Growth Desk asks Linear Handler, and its line in the chat opens the collaboration. */
const withCollaboration: Message[] = [
	said(
		"11",
		"you",
		"Checkout is timing out for some customers. Can you look?",
		"2026-09-18T06:02:00.000Z",
	),
	{
		...said("12", "bot", "Asking Linear Handler to check Sentry.", "2026-09-18T06:03:00.000Z"),
		parts: [
			{ type: "text", text: "Asking Linear Handler to check Sentry." },
			{
				type: "collaboration",
				id: "0199a3a0-0000-7000-8000-000000000592",
				agentId: linearHandler.id,
				agentName: linearHandler.name,
				threadId: collaborationId,
				brief: "Check Sentry and open an issue if nothing is tracked",
				status: "answered",
				answer: "41 events in 24h, all hitting the 30s gateway limit. I opened LIN-482.",
				atOffset: 38,
			},
		],
	},
];

function collabMessage(id: string, author: typeof asker, text: string, at: string): Message {
	return {
		id: `0199a3a0-0000-7000-8000-0000000005${id}`,
		threadId: collaborationId,
		author,
		kind: "text",
		status: "complete",
		parts: [{ type: "text", text }],
		content: text,
		createdAt: at,
	};
}

const collaboration: ThreadDetails = {
	thread: {
		id: collaborationId,
		workspaceId: growthDesk.workspaceId,
		podId: growthDesk.podId,
		hostAgentId: linearHandler.id,
		conversationId: storyConversationFor(growthDesk).id,
		type: "collaboration",
		title: "Check Sentry and open an issue if nothing is tracked",
		status: "done",
		parentThreadId: storyConversationFor(growthDesk).id,
		initiatorUserId: storyUser.id,
		doneAt: null,
		createdAt: "2026-09-18T06:03:00.000Z",
		updatedAt: "2026-09-18T06:05:00.000Z",
	},
	capabilities: { approveToolCalls: true },
	routineExecution: null,
	startedFrom: null,
	participants: [asked, asker],
	crew: [asker, asked],
	members: [],
	olderMessagesCursor: null,
	queuedSince: null,
	reads: [],
	messages: [
		collabMessage(
			"93",
			asker,
			"Ryan is seeing checkout timeouts. Check Sentry and open an issue if nothing's tracked?",
			"2026-09-18T06:03:00.000Z",
		),
		collabMessage(
			"94",
			asked,
			"41 events in 24h, all hitting the 30s gateway limit. Nothing was open, so I opened LIN-482.",
			"2026-09-18T06:05:00.000Z",
		),
	],
};

const collaborationHandlers = [
	http.get(`${API}/threads/${collaborationId}`, () => HttpResponse.json(collaboration)),
	...appHandlers({ messages: { [growthDesk.id]: withCollaboration } }),
];

/** A collaboration opened from its line: the sidebar with the two bots' thread, the chat's own on the right. */
export const Collaboration = meta.story({
	beforeEach({ msw }) {
		msw.use(...collaborationHandlers);
	},
	render: () => <StoryApp path={`${chatPath(growthDesk)}?thread=${collaborationId}`} />,
	play: async ({ canvas }) => {
		const panel = await canvas.findByRole(
			"complementary",
			{ name: collaboration.thread.title },
			{ timeout: 10_000 },
		);
		await expect(
			within(panel).getByText(`${growthDesk.name} and ${linearHandler.name}`),
		).toBeInTheDocument();
	},
});

/** The same on a phone: a sheet risen over the dimmed chat. */
export const CollaborationOnAPhone = meta.story({
	globals: { viewport: { value: "iphone12", isRotated: false } },
	beforeEach({ msw }) {
		msw.use(...collaborationHandlers);
	},
	render: () => <StoryApp path={`${chatPath(growthDesk)}?thread=${collaborationId}`} />,
	play: async ({ canvas }) => {
		await expect(
			await canvas.findByRole(
				"complementary",
				{ name: collaboration.thread.title },
				{ timeout: 10_000 },
			),
		).toBeInTheDocument();
	},
});

/** Growth Desk with the sandbox on, in a workspace that has sandboxes. */
const sandboxHandlers = (messages: Message[]) => [
	...appHandlers({
		bots: storyBots.map((bot) => (bot.id === growthDesk.id ? { ...bot, usesSandbox: true } : bot)),
		messages: { [growthDesk.id]: messages },
	}),
	http.get(`${import.meta.env.VITE_API_URL}/workspaces/:workspace/sandbox-providers/access`, () =>
		HttpResponse.json({ enabled: true }),
	),
];

/** Growth Desk's reply in progress, having opened a page in its browser. */
const browsing: Message = {
	...said("90", "bot", "", "2026-09-18T06:20:00.000Z"),
	status: "streaming",
	parts: [
		{
			type: "tool_call",
			id: "0199a3a0-0000-7000-8000-000000000591",
			tool: "browser_navigate",
			input: { url: "https://example.com/pricing" },
			output: null,
			status: "running",
			error: null,
			mutating: false,
			atOffset: 0,
			startedAt: "2026-09-18T06:20:01.000Z",
			finishedAt: null,
		},
	],
};

/** The bot's sandbox, a button at the top right of its chat that opens the desktop. */
export const Sandbox = meta.story({
	beforeEach({ msw }) {
		msw.use(...sandboxHandlers(conversation));
	},
	play: async ({ canvas }) => {
		await expect(
			await canvas.findByRole("button", { name: "Sandbox desktop" }, { timeout: 10_000 }),
		).toBeVisible();
	},
});

/**
 * While the bot is browsing, its screen shows live in the reply and the header
 * button pulses. Opening the screen shows the desktop beside the chat, watched
 * until the person takes over.
 */
export const SandboxInUse = meta.story({
	beforeEach({ msw }) {
		msw.use(...sandboxHandlers([...conversation, browsing]));
	},
	play: async ({ canvas }) => {
		const inUse = await canvas.findByRole(
			"button",
			{ name: `${growthDesk.name} is using the sandbox. Open its desktop` },
			{ timeout: 10_000 },
		);
		await expect(inUse).toHaveTextContent("Sandbox in use");
		const screen = await canvas.findByRole("article", { name: `${growthDesk.name}'s screen` });
		await userEvent.click(
			within(screen).getByRole("button", { name: `Open ${growthDesk.name}'s desktop` }),
		);
		const desktop = await canvas.findByRole("region", { name: `${growthDesk.name}'s desktop` });
		await expect(within(desktop).getByText("has control")).toBeVisible();
		await userEvent.click(within(desktop).getByRole("button", { name: "Take over" }));
		await expect(within(desktop).getByRole("button", { name: "Hand back" })).toBeVisible();
		// Only the desktop beside the chat is connected while it is open.
		await expect(canvas.queryByRole("article", { name: `${growthDesk.name}'s screen` })).toBeNull();
	},
});

/** The same on a phone: the pulse and a screen, at the right of the centred header. */
export const SandboxInUseOnAPhone = meta.story({
	globals: { viewport: { value: "iphone12", isRotated: false } },
	beforeEach({ msw }) {
		msw.use(...sandboxHandlers([...conversation, browsing]));
	},
	play: async ({ canvas }) => {
		await expect(
			await canvas.findByRole(
				"button",
				{ name: `${growthDesk.name} is using the sandbox. Open its desktop` },
				{ timeout: 10_000 },
			),
		).toBeVisible();
	},
});

const pricing = {
	id: "0199a3a0-0000-7000-8000-0000000005f1",
	podId: revenue.id,
	kind: "document",
	title: "Competitor pricing",
	version: 1,
	createdBy: { agentId: growthDesk.id, name: growthDesk.name },
	createdAt: "2026-09-18T06:08:00.000Z",
	updatedAt: "2026-09-18T06:08:00.000Z",
} as const;

const pricingContent = `# Competitor pricing

| Company | Monthly | Annual |
| --- | --- | --- |
| Ledgerly | $29 | $290 |
| Tallyhq | $35 | $336 |
| Northpass | $24 | $240 |
`;

/** Growth Desk's reply that made the pricing document. */
const madePricing: Message = {
	...said("95", "bot", "Here's the pricing, monthly and annual.", "2026-09-18T06:08:00.000Z"),
	parts: [
		{
			type: "tool_call",
			id: "0199a3a0-0000-7000-8000-000000000596",
			tool: "artifact_write",
			input: {},
			output: {
				status: "written",
				artifactId: pricing.id,
				kind: pricing.kind,
				title: pricing.title,
				version: pricing.version,
			},
			status: "completed",
			error: null,
			mutating: true,
			atOffset: 0,
			startedAt: "2026-09-18T06:07:30.000Z",
			finishedAt: "2026-09-18T06:08:00.000Z",
		},
		{ type: "text", text: "Here's the pricing, monthly and annual." },
	],
};

const artifactHandlers = () => {
	const artifacts = `${import.meta.env.VITE_API_URL}/pods/:podId/artifacts/:artifactId`;
	const shown = {
		...pricing,
		content: pricingContent,
		shownVersion: { number: 1, author: pricing.createdBy, createdAt: pricing.createdAt },
	};
	return [
		...appHandlers({ messages: { [growthDesk.id]: [...conversation, madePricing] } }),
		http.get(artifacts, () => HttpResponse.json(shown)),
		http.get(`${artifacts}/versions/:version`, () => HttpResponse.json(shown)),
		http.get(`${artifacts}/versions`, () => HttpResponse.json([shown.shownVersion])),
	];
};

/**
 * An artifact the bot made, as a card in its reply. Opening it shows it large
 * beside the chat, in the room the pod's list had, and Close brings the list back.
 * While it is open, the chat shows no artifact cards and there is no Details,
 * whose place it has taken.
 */
export const Artifact = meta.story({
	beforeEach({ msw }) {
		msw.use(...artifactHandlers());
	},
	play: async ({ canvas }) => {
		const card = await canvas.findByRole("article", { name: pricing.title }, { timeout: 10_000 });
		await userEvent.click(
			within(card).getAllByRole("button", { name: `Open ${pricing.title}` })[0] as HTMLElement,
		);
		const stage = await canvas.findByRole("region", { name: pricing.title });
		await expect(await within(stage).findByRole("columnheader", { name: "Annual" })).toBeVisible();
		await expect(canvas.queryByRole("link", { name: /Pod chat/ })).toBeNull();
		await expect(canvas.queryByRole("article", { name: pricing.title })).toBeNull();
		await expect(canvas.queryByRole("button", { name: "Details" })).toBeNull();
		await userEvent.click(within(stage).getByRole("button", { name: "Close" }));
		await expect(await canvas.findByRole("link", { name: /Pod chat/ })).toBeVisible();
		await expect(canvas.getByRole("button", { name: "Details" })).toBeVisible();
	},
});

/** On a phone the opened artifact covers the chat. */
export const ArtifactOnAPhone = meta.story({
	globals: { viewport: { value: "iphone12", isRotated: false } },
	beforeEach({ msw }) {
		msw.use(...artifactHandlers());
	},
	render: () => <StoryApp path={`${chatPath(growthDesk)}?artifact=${pricing.id}`} />,
	play: async ({ canvas }) => {
		const stage = await canvas.findByRole("region", { name: pricing.title }, { timeout: 10_000 });
		await expect(await within(stage).findByRole("columnheader", { name: "Annual" })).toBeVisible();
	},
});

const uploadedFileId = "0199a3a0-0000-7000-8000-000000000a51";
/** What the last message sent asked for, as the API received it. */
let lastSent: { message: string; attachments?: string[] } | undefined;

const attachmentHandlers = [
	http.post(`${API}/conversations/:conversationId/files`, ({ request }) => {
		const query = new URL(request.url).searchParams;
		return HttpResponse.json(
			{
				id: uploadedFileId,
				name: query.get("name"),
				contentType: query.get("type") ?? "application/octet-stream",
				size: 4,
			},
			{ status: 201 },
		);
	}),
	http.post(`${API}/conversations/:conversationId/messages`, async ({ request }) => {
		lastSent = (await request.json()) as typeof lastSent;
		return HttpResponse.json(
			said("61", "you", lastSent?.message ?? "", "2026-09-18T06:10:00.000Z"),
			{
				status: 201,
			},
		);
	}),
	...appHandlers({ messages: { [growthDesk.id]: conversation } }),
];

/**
 * A file chosen with the paperclip uploads straight away. Once it has, a message with
 * no text can carry it, and sending clears it from the composer.
 */
export const AttachAndSend = meta.story({
	beforeEach({ msw }) {
		lastSent = undefined;
		msw.use(...attachmentHandlers);
	},
	play: async ({ canvas, canvasElement }) => {
		await canvas.findByRole("textbox", { name: `Message ${growthDesk.name}` }, { timeout: 10_000 });
		const picker = canvasElement.querySelector<HTMLInputElement>('input[type="file"]');
		if (!picker) throw new Error("The composer has no file picker");
		await userEvent.upload(
			picker,
			new File(["%PDF"], "acme-retail-request.pdf", { type: "application/pdf" }),
		);
		const files = canvas.getByRole("list", { name: "Attached files" });
		await expect(within(files).getByRole("listitem")).toHaveAttribute(
			"title",
			expect.stringContaining("acme-retail-request.pdf"),
		);
		const send = canvas.getByRole("button", { name: "Send message" });
		await waitFor(() => expect(send).toBeEnabled());
		await userEvent.click(send);
		await waitFor(() => expect(lastSent?.attachments).toEqual([uploadedFileId]));
		await expect(lastSent?.message).toBe("");
		await expect(canvas.queryByRole("list", { name: "Attached files" })).not.toBeInTheDocument();
	},
});

/**
 * The API refuses a message when a file it carries is gone, such as one
 * cleared for waiting too long. Its files come back failed, saying why, and
 * Retry uploads each again from the computer.
 */
export const SendRefusedFileGone = meta.story({
	beforeEach({ msw }) {
		msw.use(
			http.post(`${API}/conversations/:conversationId/messages`, () =>
				HttpResponse.json(
					{
						_tag: "BadRequest",
						message: "A file to send is no longer there. Remove it and attach it again",
						error: {
							_tag: "UploadsNotFound",
							userMessage: "A file to send is no longer there. Remove it and attach it again",
							isRetryable: false,
						},
					},
					{ status: 400 },
				),
			),
			...attachmentHandlers,
		);
	},
	play: async ({ canvas, canvasElement }) => {
		await canvas.findByRole("textbox", { name: `Message ${growthDesk.name}` }, { timeout: 10_000 });
		const picker = canvasElement.querySelector<HTMLInputElement>('input[type="file"]');
		if (!picker) throw new Error("The composer has no file picker");
		await userEvent.upload(
			picker,
			new File(["%PDF"], "acme-retail-request.pdf", { type: "application/pdf" }),
		);
		const send = canvas.getByRole("button", { name: "Send message" });
		await waitFor(() => expect(send).toBeEnabled());
		await userEvent.click(send);

		const retry = await canvas.findByRole("button", { name: "Retry acme-retail-request.pdf" });
		await expect(retry).toHaveAccessibleDescription(
			/It was no longer there when the message was sent/,
		);
		await expect(
			canvas.getByText(/It was no longer there when the message was sent/),
		).toBeVisible();
		await expect(send).toBeDisabled();

		await userEvent.click(retry);
		await waitFor(() => expect(send).toBeEnabled());
	},
});

/** Files dragged anywhere over the chat below its header can be dropped to attach them. */
export const DraggingFiles = meta.story({
	play: async ({ canvas }) => {
		const log = await canvas.findByRole("log", { name: "Chat messages" }, { timeout: 10_000 });
		const dataTransfer = new DataTransfer();
		dataTransfer.items.add(new File(["%PDF"], "acme-retail-request.pdf"));
		log.dispatchEvent(
			new DragEvent("dragenter", { bubbles: true, cancelable: true, dataTransfer }),
		);
		await expect(await canvas.findByText("Drop files to attach")).toBeVisible();
	},
});
