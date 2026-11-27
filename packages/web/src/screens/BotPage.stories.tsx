import {
	type ListedWrittenFile,
	type Message,
	type StreamEvent,
	streamEvent,
} from "@sugabots/contracts";
import { listedChat, testMember } from "@sugabots/contracts/testing";
import { delay, HttpResponse, http } from "msw";
import { expect, screen, userEvent, waitFor, within } from "storybook/test";
import preview from "#storybook/preview";
import { growthDesk, revenue, storyBots } from "@/shell/story-fixtures.test-support.ts";
import {
	appHandlers,
	chatPath,
	connectorHandlers,
	StoryApp,
	storyChatDetails,
	storyChatFor,
	storyMember,
	storyProjectChatDetails,
	storyProjectChatFor,
	storyWorkspace,
} from "../story-app.test-support.tsx";
import { expiredConnector, expiredLinear } from "./ConnectorsNotice.test-support.ts";

/*
 * A bot's chat as the app shows it: the sidebar with the projects' chats and bots beside it, the
 * header across the top, and the chat with its composer. On a phone the chat
 * takes the screen, under a compact header with Back to the list.
 */

function said(id: string, by: "you" | "bot", text: string, at: string): Message {
	const chat = storyChatFor(growthDesk).id;
	return {
		id: `0199a3a0-0000-7000-8000-0000000005${id}`,
		chatId: chat,
		author:
			by === "you"
				? testMember({ id: storyMember.id, name: storyMember.name })
				: {
						kind: "bot",
						id: growthDesk.id,
						name: growthDesk.name,
						handle: growthDesk.handle,
						color: growthDesk.color,
						eyes: growthDesk.eyes,
						shape: growthDesk.shape,
					},
		status: "complete",
		parts: [{ type: "text", text }],
		content: text,
		createdAt: at,
	};
}

const saidInChat: Message[] = [
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
		localStorage.clear();
		msw.use(...appHandlers({ messages: { [growthDesk.id]: saidInChat } }));
	},
	render: () => <StoryApp path={chatPath(growthDesk)} />,
});

/** A bot's chat beside the sidebar, headed by its title after its bot, with Resolve in its header. */
export const Chat = meta.story({
	play: async ({ canvas }) => {
		const log = await canvas.findByRole("log", { name: "Chat messages" });
		await expect(await within(log).findByText(/Drafted both/)).toBeInTheDocument();
		await expect(
			await canvas.findByRole("heading", { name: `Working with ${growthDesk.name}`, level: 1 }),
		).toBeVisible();
		await expect(canvas.getByRole("button", { name: "Resolve" })).toBeVisible();
	},
});

const chatWithHistory = Array.from({ length: 24 }, (_, index) =>
	said(
		(index + 32).toString(16),
		index % 2 === 0 ? "you" : "bot",
		`Outbound review ${index + 1}: check the account before drafting a reply.`,
		new Date(Date.UTC(2026, 8, 18, 6, index)).toISOString(),
	),
);

const historyHandlers = () => appHandlers({ messages: { [growthDesk.id]: chatWithHistory } });

async function chatViewport(canvas: { findByRole: typeof screen.findByRole }) {
	const log = await canvas.findByRole("log", { name: "Chat messages" });
	const viewport = log.parentElement;
	if (!viewport) throw new Error("Chat messages have no scroll viewport");
	await waitFor(() => expect(viewport.scrollHeight).toBeGreaterThan(viewport.clientHeight));
	return viewport;
}

const distanceFromLatest = (viewport: HTMLElement) =>
	viewport.scrollHeight - viewport.clientHeight - viewport.scrollTop;

async function scrollBack(viewport: HTMLElement) {
	const scrolled = new Promise<void>((resolve) =>
		viewport.addEventListener("scroll", () => resolve(), { once: true }),
	);
	viewport.scrollTop = 0;
	await scrolled;
}

const thinking = [
	"Compare the prices each account already has.",
	"Check when the existing quotes expire.",
	"Keep the new prices in the same currency.",
	"Review any trial terms before drafting the replies.",
].join("\n\n");

/** Expanding a reply at the latest message keeps its newly revealed thinking in view. */
export const FollowsExpandedThinking = meta.story({
	beforeEach({ msw }) {
		const reply = {
			...said("fd", "bot", "Both quotes are ready.", "2026-09-18T06:24:00.000Z"),
			thinking: [{ step: 0, text: thinking }],
		};
		msw.use(...appHandlers({ messages: { [growthDesk.id]: [...chatWithHistory, reply] } }));
	},
	play: async ({ canvas, userEvent }) => {
		const viewport = await chatViewport(canvas);
		viewport.style.overflowAnchor = "none";
		await waitFor(() => expect(distanceFromLatest(viewport)).toBeLessThan(2));
		const heightWithThinkingClosed = viewport.scrollHeight;

		await userEvent.click(canvas.getByRole("button", { name: /^Thought:/ }));

		await expect(canvas.getByText(thinking, { normalizer: (text) => text })).toBeVisible();
		await waitFor(() => {
			expect(viewport.scrollHeight).toBeGreaterThan(heightWithThinkingClosed);
			expect(distanceFromLatest(viewport)).toBeLessThan(2);
		});
	},
});

/** A reader at the foot of the chat keeps seeing the bot's reply as it arrives. */
export const FollowsTheReply = meta.story({
	loaders: [
		() => {
			const connected = Promise.withResolvers<ReadableStreamDefaultController<Uint8Array>>();
			const stream = new ReadableStream<Uint8Array>({ start: connected.resolve });
			const encoder = new TextEncoder();
			return {
				stream,
				async emit(event: StreamEvent) {
					const controller = await connected.promise;
					controller.enqueue(encoder.encode(`data: ${JSON.stringify(event)}\n\n`));
				},
			};
		},
	],
	beforeEach({ msw, loaded }) {
		msw.use(
			http.get(
				`${API}/chats/:chatId/events`,
				() => new HttpResponse(loaded.stream, { headers: { "content-type": "text/event-stream" } }),
			),
			...historyHandlers(),
		);
	},
	play: async ({ canvas, loaded }) => {
		const viewport = await chatViewport(canvas);
		await waitFor(() => expect(distanceFromLatest(viewport)).toBeLessThan(2));
		const writing = {
			...said("fe", "bot", "Checking the Northwind accounts.", "2026-09-18T06:25:00.000Z"),
			status: "writing" as const,
		};
		const beforeWriting = viewport.scrollTop;
		await loaded.emit(streamEvent("message.created", { chatId: writing.chatId, message: writing }));
		await canvas.findByRole("status", { name: `${growthDesk.name} is typing` });
		await waitFor(() => {
			expect(viewport.scrollTop).toBeGreaterThan(beforeWriting);
			expect(distanceFromLatest(viewport)).toBeLessThan(2);
		});

		const content = [
			"Both Northwind accounts are ready to contact.",
			"Start with the team that already asked for a quote.",
			"Send the pricing comparison in a separate note.",
			"Ask whether either team needs a trial workspace.",
		].join("\n\n");
		const beforeCompletion = viewport.scrollTop;
		await loaded.emit(
			streamEvent("message.completed", {
				chatId: writing.chatId,
				messageId: writing.id,
				content,
				status: "complete",
				finishedAt: "2026-09-18T06:26:00.000Z",
			}),
		);
		await canvas.findByText("Ask whether either team needs a trial workspace.");
		await waitFor(() => {
			expect(viewport.scrollTop).toBeGreaterThan(beforeCompletion);
			expect(distanceFromLatest(viewport)).toBeLessThan(2);
		});
	},
});

/** A reader keeps their place in chat history when a phone’s keyboard opens below it. */
export const FollowsWhenTheViewportShrinks = meta.story({
	globals: { theme: "light", viewport: { value: "iphone12", isRotated: false } },
	beforeEach({ msw }) {
		msw.use(...historyHandlers());
	},
	render: () => (
		<div data-testid="phone-frame">
			<StoryApp path={chatPath(growthDesk)} />
		</div>
	),
	play: async ({ canvas }) => {
		const viewport = await chatViewport(canvas);
		await waitFor(() => expect(distanceFromLatest(viewport)).toBeLessThan(2));
		const fullHeight = viewport.clientHeight;
		viewport.style.overflowAnchor = "none";
		await scrollBack(viewport);
		const distanceBeforeResize = distanceFromLatest(viewport);
		await expect(distanceBeforeResize).toBeGreaterThan(fullHeight);

		canvas.getByTestId("phone-frame").style.setProperty("--visible-height", "340px");

		await waitFor(() => {
			expect(viewport.clientHeight).toBeLessThan(fullHeight);
			expect(distanceFromLatest(viewport)).toBeCloseTo(distanceBeforeResize, 0);
		});
	},
});

/** Sending while reading older messages brings the new message into view before and after the API answers. */
export const SendingReturnsToLatest = meta.story({
	loaders: [() => ({ sendResponse: Promise.withResolvers<void>() })],
	beforeEach({ msw, loaded }) {
		const messages = [...chatWithHistory];
		msw.use(
			http.post(`${API}/chats/:chatId/messages`, async ({ request }) => {
				const sent = (await request.json()) as { retryKey: string; message: string };
				const message = {
					...said("ff", "you", sent.message, "2026-09-18T06:30:00.000Z"),
					retryKey: sent.retryKey,
				};
				await loaded.sendResponse.promise;
				messages.push(message);
				return HttpResponse.json(message, { status: 201 });
			}),
			...appHandlers({ messages: { [growthDesk.id]: messages } }),
		);
	},
	play: async ({ canvas, loaded, userEvent }) => {
		const viewport = await chatViewport(canvas);
		await waitFor(() => expect(distanceFromLatest(viewport)).toBeLessThan(2));
		viewport.style.overflowAnchor = "none";
		const composer = canvas.getByRole("textbox", { name: `Message ${growthDesk.name}` });
		await userEvent.type(composer, "Please send the draft tomorrow.");
		await scrollBack(viewport);
		await expect(distanceFromLatest(viewport)).toBeGreaterThan(viewport.clientHeight);

		try {
			await userEvent.click(canvas.getByRole("button", { name: "Send message" }));
			await canvas.findByText("Please send the draft tomorrow.");
			await waitFor(() => expect(distanceFromLatest(viewport)).toBeLessThan(2));

			await scrollBack(viewport);
			await expect(distanceFromLatest(viewport)).toBeGreaterThan(viewport.clientHeight);
		} finally {
			loaded.sendResponse.resolve();
		}
		await waitFor(() => expect(distanceFromLatest(viewport)).toBeLessThan(2));
	},
});

/**
 * A connector whose sign-in expired: the composer says the bot can't use it,
 * with a sign-in straight from there. Closing
 * it puts it away.
 */
export const SignInExpired = meta.story({
	beforeEach({ msw }) {
		msw.use(...connectorHandlers([expiredLinear]));
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

/** Several expired at once: counted rather than named, with the bot's connectors a click away. */
export const SignInsExpired = meta.story({
	beforeEach({ msw }) {
		msw.use(
			...connectorHandlers([
				expiredLinear,
				expiredConnector(2, "Notion", "https://mcp.notion.com/mcp"),
				expiredConnector(3, "Asana", "https://mcp.asana.com/sse"),
			]),
		);
	},
	play: async ({ canvas }) => {
		await expect(
			await canvas.findByText(`${growthDesk.name} can't use 3 connectors until you sign in again.`),
		).toBeVisible();
		await expect(canvas.getByRole("link", { name: "Open connectors" })).toHaveAttribute(
			"href",
			`/${storyWorkspace.slug}/bots/${growthDesk.handle}/connectors`,
		);
	},
});

/** Replying while a sign-in is expired: the two strips stack, the reply's nearest the draft. */
export const SignInExpiredWhileReplying = meta.story({
	beforeEach({ msw }) {
		msw.use(...connectorHandlers([expiredLinear]));
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

/** Someone who can't manage the bot's connectors is told who can fix it, with nothing to press. */
export const SignInExpiredForSomeoneWhoCannotSignIn = meta.story({
	beforeEach({ msw }) {
		msw.use(
			...connectorHandlers([expiredLinear]),
			...appHandlers({
				messages: { [growthDesk.id]: saidInChat },
				bots: storyBots.map((bot) =>
					bot.id === growthDesk.id
						? {
								...bot,
								permissions: {
									...bot.permissions,
									resources: { ...bot.permissions.resources, manageConnectors: false },
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
		msw.use(...connectorHandlers([expiredLinear]));
	},
	play: async ({ canvas }) => {
		await expect(await canvas.findByText("Linear's sign-in expired.")).toBeVisible();
		await expect(canvas.getByRole("button", { name: "Sign in to Linear" })).toHaveTextContent(
			"Sign in",
		);
	},
});

/** A project opened from the sidebar opens its newest chat. */
export const ProjectOpensNewestChat = meta.story({
	render: () => <StoryApp path={`/${storyWorkspace.slug}/projects/${revenue.slug}`} />,
	play: async ({ canvas }) => {
		await canvas.findByRole("log", { name: "Chat messages" });
		await expect(canvas.getByRole("heading", { name: "Planning", level: 1 })).toBeInTheDocument();
		const list = await canvas.findByRole("region", { name: "Chats" });
		await expect(await within(list).findByRole("link", { name: /^Planning/ })).toHaveAttribute(
			"aria-current",
			"page",
		);
	},
});

/** The project's members, writing to each other: a chat with no bot in it, addressed to the project. */
const projectChat: Message[] = [
	{
		...said(
			"21",
			"you",
			"Northwind signed. Thanks for the push, everyone.",
			"2026-09-18T06:12:00.000Z",
		),
		chatId: storyProjectChatFor(revenue).id,
	},
	{
		...said("22", "you", "Drinks on Friday?", "2026-09-18T06:13:00.000Z"),
		chatId: storyProjectChatFor(revenue).id,
		author: testMember({ id: "0199a3a0-0000-7000-8000-000000000012", name: "Jay Young" }),
	},
];

/**
 * A project's chat: everyone in the project, no bot, and a composer addressed to the
 * project; its Details hold who is in it and its files.
 */
export const ProjectChat = meta.story({
	beforeEach({ msw }) {
		msw.use(...appHandlers({ projectChatMessages: { [revenue.id]: projectChat } }));
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

/** A project's chat before anyone has written in it opens on its name and the project it is in. */
export const ProjectChatEmpty = meta.story({
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
		chat: {
			...storyChatDetails(growthDesk).chat,
			id: failingAutomation.feed,
			rootChatId: failingAutomation.feed,
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
		chatId: id,
		automationName: "Overnight outbound",
		triggerKind: "routine",
		state: "failed",
		error: "Gmail refused the connection: the token has expired.",
		reply: null,
		createdAt: at,
	});
	return [
		http.get(`${API}/chats/${failingAutomation.feed}`, () => HttpResponse.json(feed)),
		http.get(`${API}/chats/${failingAutomation.feed}/messages`, () =>
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
		path={`/${storyWorkspace.slug}/bots/${growthDesk.handle}/chats/${failingAutomation.feed}`}
	/>
);

/**
 * An automation whose last two runs failed, each its own run with why it failed;
 * the latest offers Retry and the way to fix its connector, and a line says
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

/**
 * A failed run opened from its notification: the automation's feed, scrolled
 * to that run and pointed out, with the composer at its foot as in any chat.
 */
export const RunOpenedFromNotification = meta.story({
	beforeEach({ msw }) {
		msw.use(...failingAutomationHandlers());
	},
	render: () => (
		<StoryApp
			path={`/${storyWorkspace.slug}/bots/${growthDesk.handle}/chats/${failingAutomation.feed}?runChat=${failingAutomation.runs[0]}`}
		/>
	),
	play: async ({ canvas }) => {
		const log = await canvas.findByRole("log", { name: "Chat messages" });
		const [opened] = await within(log).findAllByRole("article", { name: /: Failed$/ });
		await waitFor(() => expect(opened).toHaveFocus());
		await expect(
			canvas.getByLabelText(`Message ${growthDesk.name} about this automation`),
		).toBeVisible();
	},
});

const pricingChat = {
	...storyProjectChatFor(revenue),
	id: "0199a3a0-0000-7000-8000-00000000c9f1",
	title: "Pricing",
};

/**
 * A project's chat goes by its own name, listed with the project's other
 * chats, and offers whoever runs the project a way to rename it.
 */
export const NamedChat = meta.story({
	beforeEach({ msw }) {
		const details = storyProjectChatDetails(revenue, storyBots);
		msw.use(
			http.get(`${API}/projects/${revenue.id}/chats`, () =>
				HttpResponse.json({
					automations: [],
					chats: [listedChat(storyProjectChatFor(revenue)), listedChat(pricingChat)],
				}),
			),
			http.get(`${API}/chats/${pricingChat.id}`, () =>
				HttpResponse.json({
					...details,
					chat: {
						...details.chat,
						id: pricingChat.id,
						rootChatId: pricingChat.id,
						title: "Pricing",
					},
				}),
			),
			http.get(`${API}/chats/${pricingChat.id}/messages`, () =>
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
		const list = await canvas.findByRole("region", { name: "Chats" });
		await expect(await within(list).findByRole("link", { name: /^Pricing/ })).toHaveAttribute(
			"aria-current",
			"page",
		);
		await expect(canvas.getByRole("textbox", { name: "Message Pricing" })).toBeInTheDocument();
		await userEvent.click(canvas.getByRole("button", { name: "More for Pricing" }));
		await waitFor(() =>
			expect(screen.getByRole("menuitem", { name: "Rename chat" })).toBeVisible(),
		);
	},
});

/** `minutes` before now, as an ISO time. */
const minutesAgo = (minutes: number) => new Date(Date.now() - minutes * 60_000).toISOString();

/**
 * Each chat's row says what its bots are doing, under its title: working on
 * a reply, waiting on an approval, or replied with one the viewer hasn't read.
 * A chat with none of these shows only who is talking in it.
 */
export const ChatStatuses = meta.story({
	beforeEach({ msw }) {
		const chat = storyProjectChatFor(revenue);
		const titled = (title: string, suffix: string) => ({
			...chat,
			id: `0199a3a0-0000-7000-8000-00000000c9${suffix}`,
			title,
		});
		msw.use(
			http.get(`${API}/projects/${revenue.id}/chats`, () =>
				HttpResponse.json({
					automations: [],
					chats: [
						{
							...listedChat(titled("Deploy the pricing page", "e1")),
							status: { kind: "working", since: minutesAgo(20) },
						},
						{
							...listedChat(titled("Refund for Acme", "e2")),
							status: { kind: "waiting", since: minutesAgo(2) },
						},
						{
							...listedChat(titled("Weekly revenue report", "e3")),
							status: { kind: "replied", at: minutesAgo(1) },
						},
						listedChat(chat),
					],
				}),
			),
			...appHandlers(),
		);
	},
	render: () => <StoryApp path={`/${storyWorkspace.slug}/projects/${revenue.slug}/files`} />,
	play: async ({ canvas }) => {
		const list = await canvas.findByRole("region", { name: "Chats" });
		// Working counts in seconds, in the corner where the time was.
		await expect(await within(list).findByText(/^Working 20m \d+s$/)).toBeVisible();
		await expect(within(list).getByText("Waiting 2m")).toBeVisible();
		await expect(
			within(within(list).getByRole("link", { name: /^Weekly revenue report/ })).getByText(
				"Replied",
			),
		).toBeVisible();
	},
});

/** On a phone the project's chat takes the screen, with Back to the project's list. */
export const ProjectChatOnAPhone = meta.story({
	globals: { viewport: { value: "iphone12", isRotated: false } },
	beforeEach({ msw }) {
		msw.use(...appHandlers({ projectChatMessages: { [revenue.id]: projectChat } }));
	},
	render: () => (
		<StoryApp
			path={`/${storyWorkspace.slug}/projects/${revenue.slug}/${storyProjectChatFor(revenue).id}`}
		/>
	),
	play: async ({ canvas }) => {
		await expect(
			await canvas.findByRole("link", { name: `Back to ${revenue.name}` }),
		).toBeVisible();
	},
});

/** On a phone a project opens on its chats to pick from, rather than on one of them. */
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

/** On a phone: the chat alone, with Back to the bot it is with. */
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
			http.get(`${API}/chats/:chatId`, async () => {
				await delay(DETAILS_DELAY_MS);
			}),
			...appHandlers({ messages: { [growthDesk.id]: saidInChat } }),
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
		const chat = [...saidInChat];
		msw.use(
			...appHandlers({ messages: { [growthDesk.id]: chat } }),
			http.post(`${API}/chats/:chatId/messages`, async ({ request }) => {
				const sent = (await request.json()) as {
					retryKey: string;
					message: string;
					replyTo?: string;
				};
				const quoted = saidInChat.find((message) => message.id === sent.replyTo);
				const reply: Message = {
					...said("10", "you", sent.message, "2026-09-18T06:08:00.000Z"),
					retryKey: sent.retryKey,
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
		msw.use(...reactionHandlers(saidInChat.map((message) => ({ ...message }))));
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
 * them, so a reload still has them. A reaction added is answered once
 * `addAnswered` settles, and `onTakenBack` hears each one taken back once it is.
 */
function reactionHandlers(
	chat: Message[],
	{
		addAnswered = Promise.resolve(),
		onTakenBack = () => {},
	}: { addAnswered?: Promise<void>; onTakenBack?: () => void } = {},
) {
	const you = { id: storyMember.id, name: storyMember.name, at: "2026-09-18T06:09:00.000Z" };
	const change = (messageId: string, emoji: string, reacting: boolean) => {
		const index = chat.findIndex(({ id }) => id === messageId);
		const message = chat[index];
		if (!message) return HttpResponse.json([]);
		const others = (message.reactions ?? []).map((reaction) =>
			reaction.emoji === emoji
				? { ...reaction, members: reaction.members.filter(({ id }) => id !== you.id) }
				: reaction,
		);
		const reactions = reacting
			? others.some((reaction) => reaction.emoji === emoji)
				? others.map((reaction) =>
						reaction.emoji === emoji
							? { ...reaction, members: [...reaction.members, you] }
							: reaction,
					)
				: [...others, { emoji, members: [you] }]
			: others.filter((reaction) => reaction.members.length > 0);
		chat[index] = { ...message, reactions: reactions.length > 0 ? reactions : undefined };
		return HttpResponse.json(reactions);
	};
	return [
		...appHandlers({ messages: { [growthDesk.id]: chat } }),
		http.put(`${API}/messages/:messageId/reactions/:emoji`, async ({ params }) => {
			await addAnswered;
			return change(String(params.messageId), String(params.emoji), true);
		}),
		http.delete(`${API}/messages/:messageId/reactions/:emoji`, ({ params }) => {
			const answer = change(String(params.messageId), String(params.emoji), false);
			onTakenBack();
			return answer;
		}),
	];
}

/** Jay, who reacted 👍 to the bot's question before the viewer did. */
const jay = {
	id: "0199a3a0-0000-7000-8000-0000000005f1",
	name: "Jay Park",
	at: "2026-09-18T06:08:00.000Z",
};

/**
 * `ChangeYourMindQuickly`'s chat as its API keeps it, the add it holds until
 * the play answers it, and when the take-back has reached it: made by the
 * story's setup, read by its play.
 */
let quickChange: { chat: Message[]; answerAdd: () => void; takenBack: Promise<void> } | undefined;

/**
 * Reactions are sent in the order they were made, so clicking one on and
 * straight off again leaves it off, however slowly the API answers the first.
 */
export const ChangeYourMindQuickly = meta.story({
	beforeEach({ msw }) {
		const chat = saidInChat.map((message) =>
			/Want me to draft replies/.test(message.content)
				? { ...message, reactions: [{ emoji: "👍", members: [jay] }] }
				: { ...message },
		);
		const added = Promise.withResolvers<void>();
		const takenBack = Promise.withResolvers<void>();
		quickChange = { chat, answerAdd: added.resolve, takenBack: takenBack.promise };
		msw.use(
			...reactionHandlers(chat, {
				addAnswered: added.promise,
				onTakenBack: takenBack.resolve,
			}),
		);
	},
	play: async ({ canvas }) => {
		if (!quickChange) throw new Error("The story's setup did not run");
		const { chat, answerAdd, takenBack } = quickChange;
		const log = await canvas.findByRole("log", { name: "Chat messages" });
		const asked = (await within(log).findByText(/Want me to draft replies/)).closest("article");
		if (!asked) throw new Error("The bot's question is not a message row");
		await userEvent.click(within(asked).getByRole("button", { name: /^👍/ }));
		// Taken back while the API has still not answered the add.
		await userEvent.click(
			await within(asked).findByRole("button", {
				name: "👍 2: Jay Park and You reacted with 👍",
			}),
		);
		await within(asked).findByRole("button", { name: "👍 1: Jay Park reacted with 👍" });

		answerAdd();
		await takenBack;

		const askedId = asked.getAttribute("data-message-id");
		await expect(chat.find(({ id }) => id === askedId)?.reactions).toEqual([
			{ emoji: "👍", members: [jay] },
		]);
		const thumbs = await within(asked).findByRole("button", {
			name: "👍 1: Jay Park reacted with 👍",
		});
		await expect(thumbs).toHaveAttribute("aria-pressed", "false");
	},
});

/**
 * Opens the chat's Details once the chat has loaded, and returns them.
 * The Details button is drawn while the chat loads and drawn again once it
 * has, so it is found only after; and Details may already be open, as a wide
 * screen opens them unless this browser last closed them, so it is pressed
 * only when they are closed.
 */
async function openDetails(canvas: ReturnType<typeof within>): Promise<HTMLElement> {
	await canvas.findByRole("log", { name: "Chat messages" });
	const toggle = canvas.getByRole("button", { name: "Details" });
	if (toggle.getAttribute("aria-pressed") === "false") await userEvent.click(toggle);
	return canvas.findByRole("complementary", { name: "Details" });
}

/** Details open beside the chat: the bot's card, who has written and what it can use. */
export const Details = meta.story({
	play: async ({ canvas }) => {
		await expect(await openDetails(canvas)).toBeInTheDocument();
	},
});

/** On a phone, tapping the chat's title opens Details over the whole screen, header and all. */
export const DetailsOnAPhone = meta.story({
	globals: { viewport: { value: "iphone12", isRotated: false } },
	play: async ({ canvas }) => {
		await userEvent.click(
			await canvas.findByRole("button", { name: `Details for ${storyChatFor(growthDesk).title}` }),
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
	status: "writing",
	parts: [
		{
			type: "tool_call",
			id: "0199a3a0-0000-7000-8000-000000000591",
			tool: "browser_navigate",
			input: { url: "https://example.com/pricing" },
			output: null,
			status: "running",
			error: null,
			approval: null,
			atOffset: 0,
			startedAt: "2026-09-18T06:20:01.000Z",
			finishedAt: null,
		},
	],
};

/** The bot's computer, a card in its Details from a tablet up, which opens its desktop. */
export const Computer = meta.story({
	beforeEach({ msw }) {
		msw.use(...computerHandlers(saidInChat));
	},
	play: async ({ canvas }) => {
		const details = await openDetails(canvas);
		await waitFor(() =>
			expect(within(details).getByRole("button", { name: "Not running" })).toBeVisible(),
		);
	},
});

/**
 * Without computers set up in the workspace, its card is still in Details,
 * and opens to say what computers are for and how to get them.
 */
export const NoComputer = meta.story({
	play: async ({ canvas }) => {
		const details = await openDetails(canvas);
		await userEvent.click(await within(details).findByRole("button", { name: "No computer" }));
		const computer = await canvas.findByRole("region", { name: `${growthDesk.name}'s computer` });
		await expect(await within(computer).findByText("Computers aren't set up yet")).toBeVisible();
		await expect(within(computer).getByText("No computer")).toBeVisible();
		await expect(within(computer).getByRole("link", { name: "Set up computers" })).toHaveAttribute(
			"href",
			expect.stringMatching(/[?&]settings=computers$/),
		);
	},
});

/**
 * While the bot is browsing, its screen shows live in the reply. Opening the screen shows the desktop beside the chat, watched
 * until the member takes over.
 */
export const ComputerInUse = meta.story({
	beforeEach({ msw }) {
		msw.use(...computerHandlers([...saidInChat, browsing]));
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

const pricing: ListedWrittenFile = {
	id: "0199a3a0-0000-7000-8000-0000000005f1",
	chatId: storyChatFor(growthDesk).id,
	kind: "markdown",
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
			approval: null,
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
		...appHandlers({ messages: { [growthDesk.id]: [...saidInChat, madePricing] } }),
		// The bot's files, which the file opened must be among to be shown as the bot's.
		http.get(`${API}/projects/:projectId/files`, ({ params }) =>
			HttpResponse.json(params.projectId === growthDesk.defaultProjectId ? [pricing] : []),
		),
		http.get(files, () => HttpResponse.json(shown)),
		http.get(`${files}/versions/:version`, () => HttpResponse.json(shown)),
		http.get(`${files}/versions`, () => HttpResponse.json([shown.shownVersion])),
	];
};

/**
 * A file the bot made, as a card in its reply. Opening it shows it large
 * beside the chat, and Close puts it away. While it is open, its card in the
 * chat is only its line, without the preview, and there is no Details, whose
 * place it has taken.
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
		const line = await canvas.findByRole("article", { name: pricing.title });
		await expect(within(line).queryByRole("columnheader", { name: "Annual" })).toBeNull();
		await expect(within(line).getByRole("button", { name: `Open ${pricing.title}` })).toBeVisible();
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
	http.post(`${API}/chats/:chatId/files`, ({ request }) => {
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
	http.post(`${API}/chats/:chatId/messages`, async ({ request }) => {
		lastSent = (await request.json()) as typeof lastSent;
		return HttpResponse.json(
			said("61", "you", lastSent?.message ?? "", "2026-09-18T06:10:00.000Z"),
			{
				status: 201,
			},
		);
	}),
	...appHandlers({ messages: { [growthDesk.id]: saidInChat } }),
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
			http.post(`${API}/chats/:chatId/messages`, () =>
				HttpResponse.json(
					{
						_tag: "BadRequest",
						message: "A file to send is no longer there. Remove it and attach it again",
						error: {
							_tag: "UnsentAttachmentsNotFound",
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
