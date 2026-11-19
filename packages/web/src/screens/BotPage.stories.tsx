import type { ConversationDetails, Message, WrittenFileSummary } from "@sugabots/contracts";
import { type TestConnection, testPerson } from "@sugabots/contracts/testing";
import { delay, HttpResponse, http } from "msw";
import { expect, screen, userEvent, waitFor, within } from "storybook/test";
import preview from "#storybook/preview";
import { growthDesk, linearHandler, revenue } from "@/shell/story-fixtures.ts";
import {
	appHandlers,
	chatPath,
	connectionHandlers,
	StoryApp,
	storyBots,
	storyChatDetails,
	storyListedThread,
	storyProjectThreadDetails,
	storyProjectThreadFor,
	storyThreadFor,
	storyUser,
	storyWorkspace,
} from "../story-app.tsx";

/*
 * A bot's thread as the app shows it: the sidebar with the projects' threads and bots beside it, the
 * header across the top, and the thread with its composer. On a phone the chat
 * takes the screen, under a compact header with Back to the list.
 */

function said(id: string, by: "you" | "bot", text: string, at: string): Message {
	const thread = storyThreadFor(growthDesk).id;
	return {
		id: `0199a3a0-0000-7000-8000-0000000005${id}`,
		conversationId: thread,
		author:
			by === "you"
				? testPerson({ id: storyUser.id, name: storyUser.name })
				: {
						kind: "bot",
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

/** A bot's thread beside the sidebar, headed by its title after its bot, with Mark done in its header. */
export const Conversation = meta.story({
	play: async ({ canvas }) => {
		const log = await canvas.findByRole("log", { name: "Chat messages" });
		await expect(await within(log).findByText(/Drafted both/)).toBeInTheDocument();
		await expect(
			await canvas.findByRole("heading", { name: `Working with ${growthDesk.name}`, level: 1 }),
		).toBeVisible();
		await expect(canvas.getByRole("button", { name: "Mark done" })).toBeVisible();
	},
});

/** A bot's connection whose sign-in the server refused during a turn. */
function expiredConnection(n: number, name: string, url: string): TestConnection {
	return {
		id: `0199a3a0-0000-7000-8000-0000000007${String(n).padStart(2, "0")}`,
		workspaceId: revenue.workspaceId,
		projectId: "0199a3a0-0000-7000-8000-00000000b071",
		name,
		handle: name.toLowerCase(),
		url,
		kind: "mcp",
		auth: "oauth",
		signedIn: false,
		signInExpired: true,
		secretHeader: null,
		hasSecret: false,
		appSettingsUrl: null,
		status: "connected",
		tools: [
			{
				name: "search",
				description: "Search",
				readOnly: true,
				destructive: false,
				access: "allow",
			},
		],
		lastTestError: null,
		connectedBy: {
			id: "0199a3a0-0000-7000-8000-0000000000c3",
			name: "Sam Rivera",
			email: "sam.rivera@example.com",
			image: null,
		},
		createdAt: "2026-09-01T00:00:00.000Z",
	};
}

const expiredLinear = expiredConnection(1, "Linear", "https://mcp.linear.app/mcp");

/**
 * A connection whose sign-in expired: the composer says the bot can't use it,
 * with a sign-in straight from there. Closing
 * it puts it away.
 */
export const SignInExpired = meta.story({
	beforeEach({ msw }) {
		msw.use(...connectionHandlers([expiredLinear]));
	},
	play: async ({ canvas }) => {
		const said = await canvas.findByText("Growth Desk can't use Linear until you sign in again.");
		await expect(said).toBeVisible();
		const notice = said.closest("p")?.parentElement;
		if (!notice) throw new Error("The notice is not a strip of its own");
		await expect(within(notice).getByRole("button", { name: "Sign in to Linear" })).toBeVisible();
		await userEvent.click(canvas.getByRole("button", { name: "Dismiss" }));
		await expect(canvas.queryByText(/can't use Linear/)).toBeNull();
	},
});

/** Several expired at once: counted rather than named, with the bot's connections a click away. */
export const SignInsExpired = meta.story({
	beforeEach({ msw }) {
		msw.use(
			...connectionHandlers([
				expiredLinear,
				expiredConnection(2, "Notion", "https://mcp.notion.com/mcp"),
				expiredConnection(3, "Asana", "https://mcp.asana.com/sse"),
			]),
		);
	},
	play: async ({ canvas }) => {
		await expect(await canvas.findByText("3 connections' sign-ins expired.")).toBeVisible();
		await expect(canvas.getByRole("link", { name: "Open connections" })).toHaveAttribute(
			"href",
			`/${storyWorkspace.slug}/bots/${growthDesk.handle}/connections`,
		);
	},
});

/** Replying while a sign-in is expired: the two strips stack, the reply's nearest the draft. */
export const SignInExpiredWhileReplying = meta.story({
	beforeEach({ msw }) {
		msw.use(...connectionHandlers([expiredLinear]));
	},
	play: async ({ canvas }) => {
		const log = await canvas.findByRole("log", { name: "Chat messages" });
		const message = (await within(log).findByText(/Drafted both/)).closest("article");
		if (!message) throw new Error("The bot's message is not a message row");
		within(message).getByRole("button", { name: "Reply" }).focus();
		await userEvent.keyboard("{Enter}");
		const notice = await canvas.findByText(/can't use Linear/);
		const replying = await canvas.findByText(/Replying to/);
		await expect(
			notice.compareDocumentPosition(replying) & Node.DOCUMENT_POSITION_FOLLOWING,
		).toBeTruthy();
		// The reply is kept as the chat's draft, so it is let go of for the stories after this one.
		await userEvent.click(canvas.getByRole("button", { name: /^Stop replying to / }));
	},
});

/** Someone who can't manage the bot's connections is told who can fix it, with nothing to press. */
export const SignInExpiredForSomeoneWhoCannotSignIn = meta.story({
	beforeEach({ msw }) {
		msw.use(
			...connectionHandlers([expiredLinear]),
			...appHandlers({
				messages: { [growthDesk.id]: conversation },
				bots: storyBots.map((bot) =>
					bot.id === growthDesk.id
						? {
								...bot,
								permissions: {
									...bot.permissions,
									resources: { ...bot.permissions.resources, manageConnections: false },
								},
							}
						: bot,
				),
			}),
		);
	},
	play: async ({ canvas }) => {
		await expect(
			await canvas.findByText(
				"Growth Desk can't use Linear until someone who manages it signs in again.",
			),
		).toBeVisible();
		await expect(canvas.queryByRole("button", { name: "Sign in to Linear" })).toBeNull();
	},
});

/** On a phone the strip says only what happened, so it keeps to one line beside its button. */
export const SignInExpiredOnAPhone = meta.story({
	globals: { viewport: { value: "iphone12", isRotated: false } },
	beforeEach({ msw }) {
		msw.use(...connectionHandlers([expiredLinear]));
	},
	play: async ({ canvas }) => {
		await expect(await canvas.findByText("Linear's sign-in expired.")).toBeVisible();
		await expect(canvas.getByRole("button", { name: "Sign in to Linear" })).toHaveTextContent(
			"Sign in",
		);
	},
});

/** A project opened from the sidebar opens its newest thread. */
export const ProjectOpensNewestThread = meta.story({
	render: () => <StoryApp path={`/${storyWorkspace.slug}/projects/${revenue.slug}`} />,
	play: async ({ canvas }) => {
		await canvas.findByRole("log", { name: "Chat messages" });
		await expect(canvas.getByRole("heading", { name: "Planning", level: 1 })).toBeInTheDocument();
		const list = await canvas.findByRole("region", { name: "Threads" });
		await expect(await within(list).findByRole("link", { name: /^Planning/ })).toHaveAttribute(
			"aria-current",
			"page",
		);
	},
});

/** The project's people, writing to each other: a thread with no bot in it, addressed to the project. */
const projectThread: Message[] = [
	{
		...said(
			"21",
			"you",
			"Northwind signed. Thanks for the push, everyone.",
			"2026-09-18T06:12:00.000Z",
		),
		conversationId: storyProjectThreadFor(revenue).id,
	},
	{
		...said("22", "you", "Drinks on Friday?", "2026-09-18T06:13:00.000Z"),
		conversationId: storyProjectThreadFor(revenue).id,
		author: testPerson({ id: "0199a3a0-0000-7000-8000-000000000012", name: "Jay Young" }),
	},
];

/**
 * A project's thread: everyone in the project, no bot, and a composer addressed to the
 * project; its Details hold who is in it and its files.
 */
export const ProjectThread = meta.story({
	beforeEach({ msw }) {
		msw.use(...appHandlers({ projectThreadMessages: { [revenue.id]: projectThread } }));
	},
	render: () => <StoryApp path={`/${storyWorkspace.slug}/projects/${revenue.slug}`} />,
	play: async ({ canvas }) => {
		const log = await canvas.findByRole("log", { name: "Chat messages" });
		await expect(await within(log).findByText(/Drinks on Friday/)).toBeInTheDocument();
		await expect(canvas.getByRole("heading", { name: "Planning", level: 1 })).toBeInTheDocument();
		await expect(canvas.getByRole("textbox", { name: "Message Planning" })).toBeInTheDocument();
		await expect(canvas.getByRole("button", { name: "Details" })).toBeInTheDocument();
	},
});

/** An automation's result, posted by its bot in the project's thread. */
const automationResult: Message = {
	...said("23", "bot", "Six of the overnight leads replied.", "2026-09-18T06:14:00.000Z"),
	conversationId: storyProjectThreadFor(revenue).id,
	automationResultOf: {
		runId: "0199a3a0-0000-7000-8000-0000000005e1",
		conversationId: "0199a3a0-0000-7000-8000-0000000005e2",
		automationId: "0199a3a0-0000-7000-8000-0000000005e3",
		automationName: "Overnight outbound",
	},
};

/** An automation's result in the project's thread says which automation it is from. */
export const ProjectThreadAutomationResult = meta.story({
	beforeEach({ msw }) {
		msw.use(
			...appHandlers({
				projectThreadMessages: { [revenue.id]: [...projectThread, automationResult] },
			}),
		);
	},
	render: () => <StoryApp path={`/${storyWorkspace.slug}/projects/${revenue.slug}`} />,
	play: async ({ canvas }) => {
		const log = await canvas.findByRole("log", { name: "Chat messages" });
		const result = (await within(log).findByText(/overnight leads replied/)).closest("article");
		if (!result) throw new Error("The automation's result is not a message row");
		await expect(
			within(result).getByRole("button", { name: "From Overnight outbound" }),
		).toBeInTheDocument();
	},
});

/** A project's thread before anyone has written in it opens on its name and the project it is in. */
export const ProjectThreadEmpty = meta.story({
	render: () => <StoryApp path={`/${storyWorkspace.slug}/projects/${revenue.slug}`} />,
	play: async ({ canvas }) => {
		const log = await canvas.findByRole("log", { name: "Chat messages" });
		await expect(
			await within(log).findByRole("heading", { name: "Planning", level: 2 }),
		).toBeVisible();
		await expect(within(log).getByText(`In ${revenue.name}`)).toBeVisible();
	},
});

const failingAutomation = {
	id: "0199a3a0-0000-7000-8000-0000000003b1",
	feed: "0199a3a0-0000-7000-8000-0000000003b2",
	runs: ["0199a3a0-0000-7000-8000-0000000003b3", "0199a3a0-0000-7000-8000-0000000003b4"],
};

/** The automation's feed, with its two failed runs and the line saying it paused itself. */
function failingAutomationHandlers() {
	const feed = {
		...storyChatDetails(growthDesk),
		conversation: {
			...storyChatDetails(growthDesk).conversation,
			id: failingAutomation.feed,
			rootConversationId: failingAutomation.feed,
			kind: "automation_feed" as const,
			title: "Overnight outbound",
		},
		automation: {
			id: failingAutomation.id,
			projectId: growthDesk.defaultProjectId,
			state: "paused" as const,
			failed: true,
			pausedAfterFailures: true,
		},
	};
	const run = (id: string, at: string) => ({
		kind: "run",
		id,
		conversationId: id,
		automationName: "Overnight outbound",
		triggerKind: "routine",
		state: "failed",
		error: "Gmail refused the connection: the token has expired.",
		report: null,
		createdAt: at,
	});
	return [
		http.get(`${API}/conversations/${failingAutomation.feed}`, () => HttpResponse.json(feed)),
		http.get(`${API}/conversations/${failingAutomation.feed}/messages`, () =>
			HttpResponse.json({
				items: [
					run(failingAutomation.runs[0] as string, "2026-09-17T06:00:00.000Z"),
					run(failingAutomation.runs[1] as string, "2026-09-18T06:00:00.000Z"),
					{
						kind: "automation_paused",
						id: failingAutomation.id,
						createdAt: "2026-09-18T06:01:00.000Z",
					},
				],
				nextCursor: null,
			}),
		),
		...appHandlers(),
	];
}

/** The feed is Growth Desk's own, as the automation is in its default project. */
const failingAutomationFeed = () => (
	<StoryApp
		path={`/${storyWorkspace.slug}/bots/${growthDesk.handle}/threads/${failingAutomation.feed}`}
	/>
);

/**
 * An automation whose last two runs failed, each its own run with why it failed;
 * the latest offers Retry and the way to fix its connection, and a line says
 * the automation paused itself, which its switch shows.
 */
export const FailingAutomation = meta.story({
	beforeEach({ msw }) {
		msw.use(...failingAutomationHandlers());
	},
	render: failingAutomationFeed,
	play: async ({ canvas, userEvent }) => {
		const log = await canvas.findByRole("log", { name: "Chat messages" });
		const failures = await within(log).findAllByRole("article", { name: /: Failed$/ });
		await expect(failures).toHaveLength(2);
		await expect(
			within(failures[0] as HTMLElement).queryByRole("button", { name: "Retry" }),
		).toBeNull();
		await expect(
			within(failures[1] as HTMLElement).getByRole("button", { name: "Retry" }),
		).toBeVisible();
		await expect(within(log).getAllByText(/^Run (today|yesterday|on )/)).toHaveLength(2);
		await expect(
			within(log).getByText("Paused after two failed runs in a row."),
		).toBeInTheDocument();
		await userEvent.click(canvas.getByRole("button", { name: "Details" }));
		await expect(canvas.getByRole("switch", { name: "Automation on" })).not.toBeChecked();
	},
});

const pricingChat = {
	...storyProjectThreadFor(revenue),
	id: "0199a3a0-0000-7000-8000-00000000c9f1",
	title: "Pricing",
};

/**
 * A project's thread goes by its own name, listed with the project's other
 * threads, and offers whoever runs the project a way to rename or archive it.
 */
export const NamedChat = meta.story({
	beforeEach({ msw }) {
		const details = storyProjectThreadDetails(revenue, storyBots);
		msw.use(
			http.get(`${API}/projects/${revenue.id}/threads`, () =>
				HttpResponse.json({
					automations: [],
					threads: [
						storyListedThread(storyProjectThreadFor(revenue)),
						storyListedThread(pricingChat),
					],
				}),
			),
			http.get(`${API}/conversations/${pricingChat.id}`, () =>
				HttpResponse.json({
					...details,
					conversation: {
						...details.conversation,
						id: pricingChat.id,
						rootConversationId: pricingChat.id,
						title: "Pricing",
					},
				}),
			),
			http.get(`${API}/conversations/${pricingChat.id}/messages`, () =>
				HttpResponse.json({ items: [], nextCursor: null }),
			),
			...appHandlers(),
		);
	},
	render: () => (
		<StoryApp path={`/${storyWorkspace.slug}/projects/${revenue.slug}/${pricingChat.id}`} />
	),
	play: async ({ canvas }) => {
		await expect(await canvas.findByRole("heading", { name: "Pricing", level: 1 })).toBeVisible();
		const list = await canvas.findByRole("region", { name: "Threads" });
		await expect(await within(list).findByRole("link", { name: /^Pricing/ })).toHaveAttribute(
			"aria-current",
			"page",
		);
		await expect(canvas.getByRole("textbox", { name: "Message Pricing" })).toBeInTheDocument();
		await userEvent.click(canvas.getByRole("button", { name: "More for Pricing" }));
		await expect(await screen.findByRole("menuitem", { name: "Rename thread" })).toBeVisible();
		await expect(screen.getByRole("menuitem", { name: "Archive thread" })).toBeVisible();
	},
});

/** On a phone the project's thread takes the screen, with Back to the project's list. */
export const ProjectThreadOnAPhone = meta.story({
	globals: { viewport: { value: "iphone12", isRotated: false } },
	beforeEach({ msw }) {
		msw.use(...appHandlers({ projectThreadMessages: { [revenue.id]: projectThread } }));
	},
	render: () => (
		<StoryApp
			path={`/${storyWorkspace.slug}/projects/${revenue.slug}/${storyProjectThreadFor(revenue).id}`}
		/>
	),
	play: async ({ canvas }) => {
		await expect(
			await canvas.findByRole("link", { name: `Back to ${revenue.name}` }),
		).toBeVisible();
	},
});

/** On a phone a project opens on its threads to pick from, rather than on one of them. */
export const ProjectOnAPhone = meta.story({
	globals: { viewport: { value: "iphone12", isRotated: false } },
	render: () => <StoryApp path={`/${storyWorkspace.slug}/projects/${revenue.slug}`} />,
	play: async ({ canvas }) => {
		await expect(
			await canvas.findByRole("heading", { name: revenue.name, level: 1 }),
		).toBeVisible();
		await expect(await canvas.findByRole("link", { name: /^Planning/ })).toBeVisible();
		await expect(canvas.queryByRole("log", { name: "Chat messages" })).toBeNull();
	},
});

/** On a phone: the thread alone, with Back to the bot it is with. */
export const Phone = meta.story({
	globals: { viewport: { value: "iphone12", isRotated: false } },
	play: async ({ canvas }) => {
		await expect(
			await canvas.findByRole("link", { name: `Back to ${growthDesk.name}` }),
		).toBeInTheDocument();
	},
});

/**
 * On a phone, a chat whose details arrive after its messages still shows the
 * messages once they do, rather than staying blank.
 */
export const PhoneDetailsAfterMessages = meta.story({
	globals: { viewport: { value: "iphone12", isRotated: false } },
	beforeEach({ msw }) {
		msw.use(
			// Answered by the app's own handler after the wait, once the messages are in.
			http.get(`${API}/conversations/:conversationId`, async () => {
				await delay(DETAILS_DELAY_MS);
			}),
			...appHandlers({ messages: { [growthDesk.id]: conversation } }),
		);
	},
	play: async ({ canvas }) => {
		const message = await canvas.findByText(
			"Drafted both. They're in your outbox for a last look.",
		);
		await waitFor(() => expect(message).toBeVisible());
	},
});

/** How long the API takes to answer a chat's details, well after its messages. */
const DETAILS_DELAY_MS = 600;

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
		const log = await canvas.findByRole("log", { name: "Chat messages" });
		const asked = (await within(log).findByText(/Want me to draft replies/)).closest("article");
		if (!asked) throw new Error("The bot's question is not a message row");
		within(asked).getByRole("button", { name: "Reply" }).focus();
		await userEvent.keyboard("{Enter}");
		const composer = canvas.getByRole("textbox", { name: `Message ${growthDesk.name}` });
		await expect(composer).toHaveFocus();
		await expect(canvas.getByRole("button", { name: /^Stop replying to / })).toBeVisible();

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
		await expect(canvas.queryByRole("button", { name: /^Stop replying to / })).toBeNull();
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
		const log = await canvas.findByRole("log", { name: "Chat messages" });
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
		await waitFor(() =>
			expect(within(picker).getByRole("gridcell", { name: "Hundred points" })).toHaveAttribute(
				"aria-selected",
				"true",
			),
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
		const log = await canvas.findByRole("log", { name: "Chat messages" });
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
		await userEvent.click(await canvas.findByRole("button", { name: "Details" }));
		await expect(await canvas.findByRole("complementary", { name: "Details" })).toBeInTheDocument();
	},
});

/** On a phone, tapping the thread's title opens Details over the whole screen, header and all. */
export const DetailsOnAPhone = meta.story({
	globals: { viewport: { value: "iphone12", isRotated: false } },
	play: async ({ canvas }) => {
		await userEvent.click(
			await canvas.findByRole("button", { name: storyThreadFor(growthDesk).title }),
		);
		await expect(await canvas.findByRole("complementary", { name: "Details" })).toBeInTheDocument();
	},
});

/** On a tablet there is no room beside the chat, so Details slides over it from the right. */
export const DetailsOnATablet = meta.story({
	globals: { viewport: { value: "ipad11p", isRotated: false } },
	play: async ({ canvas }) => {
		await userEvent.click(await canvas.findByRole("button", { name: "Details" }));
		await expect(await canvas.findByRole("complementary", { name: "Details" })).toBeInTheDocument();
		await expect(canvas.getByRole("log", { name: "Chat messages" })).toBeInTheDocument();
	},
});

const API = import.meta.env.VITE_API_URL as string;
const collaborationId = "0199a3a0-0000-7000-8000-000000000591";

const asker = {
	kind: "bot" as const,
	id: growthDesk.id,
	name: growthDesk.name,
	handle: growthDesk.handle,
	color: growthDesk.color,
	face: growthDesk.face,
	shape: growthDesk.shape,
};
const asked = {
	kind: "bot" as const,
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
				botId: linearHandler.id,
				botName: linearHandler.name,
				conversationId: collaborationId,
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
		conversationId: collaborationId,
		author,
		kind: "text",
		status: "complete",
		parts: [{ type: "text", text }],
		content: text,
		createdAt: at,
	};
}

const collaboration: ConversationDetails = {
	conversation: {
		id: collaborationId,
		workspaceId: growthDesk.workspaceId,
		projectId: null,
		botId: linearHandler.id,
		rootConversationId: storyThreadFor(growthDesk).id,
		kind: "collaboration",
		title: "Check Sentry and open an issue if nothing is tracked",
		status: "done",
		parentConversationId: storyThreadFor(growthDesk).id,
		startedById: storyUser.id,
		doneAt: null,
		createdAt: "2026-09-18T06:03:00.000Z",
		updatedAt: "2026-09-18T06:05:00.000Z",
	},
	capabilities: { approveToolCalls: true },
	automationRun: null,
	participants: [asked, asker],
	projectBots: [asker, asked],
	members: [],
	olderMessagesCursor: null,
	queuedSince: null,
	reads: [],
	messages: [
		collabMessage(
			"93",
			asker,
			"Rowan is seeing checkout timeouts. Check Sentry and open an issue if nothing's tracked?",
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
	http.get(`${API}/conversations/${collaborationId}`, () => HttpResponse.json(collaboration)),
	...appHandlers({ messages: { [growthDesk.id]: withCollaboration } }),
];

/** A collaboration opened from its line: the sidebar with the two bots' conversation, the chat's own on the right. */
export const Collaboration = meta.story({
	beforeEach({ msw }) {
		msw.use(...collaborationHandlers);
	},
	render: () => <StoryApp path={`${chatPath(growthDesk)}?item=${collaborationId}`} />,
	play: async ({ canvas }) => {
		const panel = await canvas.findByRole("complementary", {
			name: collaboration.conversation.title,
		});
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
	render: () => <StoryApp path={`${chatPath(growthDesk)}?item=${collaborationId}`} />,
	play: async ({ canvas }) => {
		await expect(
			await canvas.findByRole("complementary", { name: collaboration.conversation.title }),
		).toBeInTheDocument();
	},
});

/** Growth Desk with the computer on, in a workspace that has computers. */
const computerHandlers = (messages: Message[]) => [
	// Before the app's own handlers, whose default has no computers.
	http.get(`${import.meta.env.VITE_API_URL}/workspaces/:workspace/computer-providers/access`, () =>
		HttpResponse.json({ enabled: true }),
	),
	...appHandlers({
		bots: storyBots.map((bot) => (bot.id === growthDesk.id ? { ...bot, usesComputer: true } : bot)),
		messages: { [growthDesk.id]: messages },
	}),
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

/** The bot's computer, a card in its Details from a tablet up, which opens its desktop. */
export const Computer = meta.story({
	beforeEach({ msw }) {
		msw.use(...computerHandlers(conversation));
	},
	play: async ({ canvas, userEvent }) => {
		await userEvent.click(await canvas.findByRole("button", { name: "Details" }));
		const details = await canvas.findByRole("complementary", { name: "Details" });
		await expect(await within(details).findByRole("button", { name: "Not running" })).toBeVisible();
	},
});

/**
 * Without computers set up in the workspace, its card is still in Details,
 * and opens to say what computers are for and how to get them.
 */
export const NoComputer = meta.story({
	play: async ({ canvas, userEvent }) => {
		await userEvent.click(await canvas.findByRole("button", { name: "Details" }));
		const details = await canvas.findByRole("complementary", { name: "Details" });
		await userEvent.click(await within(details).findByRole("button", { name: "No computer" }));
		const computer = await canvas.findByRole("region", { name: `${growthDesk.name}'s computer` });
		await expect(await within(computer).findByText("Computers aren't set up yet")).toBeVisible();
		await expect(within(computer).getByText("No computer")).toBeVisible();
		await expect(within(computer).getByRole("link", { name: "Set up computers" })).toHaveAttribute(
			"href",
			expect.stringMatching(/\/settings\/computers$/),
		);
	},
});

/**
 * While the bot is browsing, its screen shows live in the reply. Opening the screen shows the desktop beside the chat, watched
 * until the person takes over.
 */
export const ComputerInUse = meta.story({
	beforeEach({ msw }) {
		msw.use(...computerHandlers([...conversation, browsing]));
	},
	play: async ({ canvas }) => {
		const screen = await canvas.findByRole("article", { name: `${growthDesk.name}'s screen` });
		await userEvent.click(
			within(screen).getByRole("button", { name: `Open ${growthDesk.name}'s desktop` }),
		);
		const desktop = await canvas.findByRole("region", { name: `${growthDesk.name}'s computer` });
		await expect(within(desktop).getByText("has control")).toBeVisible();
		await userEvent.click(within(desktop).getByRole("button", { name: "Take over" }));
		await expect(within(desktop).getByRole("button", { name: "Hand back" })).toBeVisible();
		// Only the desktop beside the chat is connected while it is open.
		await expect(canvas.queryByRole("article", { name: `${growthDesk.name}'s screen` })).toBeNull();
	},
});

const pricing: WrittenFileSummary = {
	id: "0199a3a0-0000-7000-8000-0000000005f1",
	conversationId: storyThreadFor(growthDesk).id,
	kind: "document",
	title: "Competitor pricing",
	version: 1,
	createdBy: { botId: growthDesk.id, name: growthDesk.name },
	createdAt: "2026-09-18T06:08:00.000Z",
	updatedAt: "2026-09-18T06:08:00.000Z",
};

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
			tool: "file_write",
			input: {},
			output: {
				status: "written",
				fileId: pricing.id,
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

const fileHandlers = () => {
	const files = `${API}/files/:fileId`;
	const shown = {
		...pricing,
		content: pricingContent,
		shownVersion: { number: 1, author: pricing.createdBy, createdAt: pricing.createdAt },
	};
	return [
		...appHandlers({ messages: { [growthDesk.id]: [...conversation, madePricing] } }),
		http.get(files, () => HttpResponse.json(shown)),
		http.get(`${files}/versions/:version`, () => HttpResponse.json(shown)),
		http.get(`${files}/versions`, () => HttpResponse.json([shown.shownVersion])),
	];
};

/**
 * A file the bot made, as a card in its reply. Opening it shows it large
 * beside the chat, and Close puts it away. While it is open, the chat shows no
 * file cards and there is no Details, whose place it has taken.
 */
export const OpenFile = meta.story({
	beforeEach({ msw }) {
		msw.use(...fileHandlers());
	},
	play: async ({ canvas }) => {
		const card = await canvas.findByRole("article", { name: pricing.title });
		await userEvent.click(
			within(card).getAllByRole("button", { name: `Open ${pricing.title}` })[0] as HTMLElement,
		);
		const stage = await canvas.findByRole("region", { name: pricing.title });
		await expect(await within(stage).findByRole("columnheader", { name: "Annual" })).toBeVisible();
		await expect(canvas.queryByRole("article", { name: pricing.title })).toBeNull();
		await expect(canvas.queryByRole("button", { name: "Details" })).toBeNull();
		await userEvent.click(within(stage).getByRole("button", { name: "Close" }));
		await expect(await canvas.findByRole("button", { name: "Details" })).toBeVisible();
		await expect(canvas.queryByRole("region", { name: pricing.title })).toBeNull();
	},
});

/** On a phone the opened file covers the chat. */
export const FileOnAPhone = meta.story({
	globals: { viewport: { value: "iphone12", isRotated: false } },
	beforeEach({ msw }) {
		msw.use(...fileHandlers());
	},
	render: () => <StoryApp path={`${chatPath(growthDesk)}?file=${pricing.id}`} />,
	play: async ({ canvas }) => {
		const stage = await canvas.findByRole("region", { name: pricing.title });
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
		await canvas.findByRole("textbox", { name: `Message ${growthDesk.name}` });
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
		await canvas.findByRole("textbox", { name: `Message ${growthDesk.name}` });
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
		// Send went with the files it sent and is back with them, so it is found again.
		const sendAgain = canvas.getByRole("button", { name: "Send message" });
		await expect(sendAgain).toBeDisabled();

		await userEvent.click(retry);
		await waitFor(() => expect(sendAgain).toBeEnabled());
	},
});

/** Files dragged anywhere over the chat below its header can be dropped to attach them. */
export const DraggingFiles = meta.story({
	play: async ({ canvas }) => {
		const log = await canvas.findByRole("log", { name: "Chat messages" });
		const dataTransfer = new DataTransfer();
		dataTransfer.items.add(new File(["%PDF"], "acme-retail-request.pdf"));
		log.dispatchEvent(
			new DragEvent("dragenter", { bubbles: true, cancelable: true, dataTransfer }),
		);
		await expect(await canvas.findByText("Drop files to attach")).toBeVisible();
	},
});
