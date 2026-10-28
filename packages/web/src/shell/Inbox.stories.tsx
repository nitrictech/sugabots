import type { ActivityFeed, ActivityItem, Message } from "@sugabots/contracts";
import { testPerson } from "@sugabots/contracts/testing";
import { HttpResponse, http } from "msw";
import { expect, screen, userEvent, within } from "storybook/test";
import preview from "#storybook/preview";
import { accountManager, growthDesk, revenue } from "@/shell/story-fixtures.ts";
import { appHandlers, StoryApp, storyConversationFor, storyWorkspace } from "@/story-app.tsx";

/*
 * Inbox, opened from the sidebar: what is new across the workspace's chats,
 * mentions of you, messages you have not read, routine runs and
 * collaborations, narrowed by kind and by unread or read. A message opens its
 * chat; a run or collaboration opens as a page of its own.
 */

const API = import.meta.env.VITE_API_URL as string;

type MessageItem = Extract<ActivityItem, { messageId: string }>;

const minutesAgo = (minutes: number) => new Date(Date.now() - minutes * 60_000).toISOString();

const feed: ActivityFeed = {
	items: [
		{
			kind: "mention",
			unread: true,
			messageId: "0199a3a0-0000-7000-8000-000000000801",
			author: testPerson({ id: "0199a3a0-0000-7000-8000-000000000011", name: "Jay Yu" }),
			preview: "@ryan-eyes can you sign off the Acme quote before 5?",
			at: minutesAgo(4),
			podId: revenue.id,
			conversationId: storyConversationFor(growthDesk).id,
		},
		{
			kind: "message",
			unread: true,
			messageId: "0199a3a0-0000-7000-8000-000000000802",
			author: {
				kind: "agent",
				id: accountManager.id,
				name: accountManager.name,
				handle: accountManager.handle,
				color: accountManager.color,
				face: accountManager.face,
				shape: "circle",
			},
			preview: "Renewal notes for Halcyon are ready.",
			at: minutesAgo(40),
			podId: revenue.id,
			conversationId: storyConversationFor(accountManager).id,
		},
		{
			kind: "routine",
			threadId: "0199a3a0-0000-7000-8000-000000000811",
			routineName: "Overnight outbound",
			state: "completed",
			triggerKind: "cron",
			preview:
				"Queued 38 leads overnight and six have already replied. The two Northwind accounts both asked for pricing.",
			agent: {
				kind: "agent",
				id: growthDesk.id,
				name: growthDesk.name,
				handle: growthDesk.handle,
				color: growthDesk.color,
				face: growthDesk.face,
				shape: "circle",
			},
			at: minutesAgo(90),
			unread: true,
			podId: revenue.id,
			conversationId: storyConversationFor(growthDesk).id,
		},
		{
			kind: "collaboration",
			threadId: "0199a3a0-0000-7000-8000-000000000812",
			initiator: {
				kind: "agent",
				id: growthDesk.id,
				name: growthDesk.name,
				handle: growthDesk.handle,
				color: growthDesk.color,
				face: growthDesk.face,
				shape: "circle",
			},
			recipient: {
				kind: "agent",
				id: accountManager.id,
				name: accountManager.name,
				handle: accountManager.handle,
				color: accountManager.color,
				face: accountManager.face,
				shape: "circle",
			},
			status: "pending",
			brief: "Check whether Acme can have 25% off the annual tier.",
			at: minutesAgo(120),
			unread: false,
			podId: revenue.id,
			conversationId: storyConversationFor(growthDesk).id,
		},
		{
			kind: "mention",
			unread: false,
			messageId: "0199a3a0-0000-7000-8000-000000000803",
			author: testPerson({ id: "0199a3a0-0000-7000-8000-000000000012", name: "Priya Kaur" }),
			preview: "Thanks @ryan-eyes, that fixed it.",
			at: minutesAgo(26 * 60),
			podId: revenue.id,
			conversationId: storyConversationFor(growthDesk).id,
		},
	],
};

const meta = preview.meta({
	title: "Views/Inbox",
	tags: ["ai-generated"],
	parameters: { layout: "fullscreen" },
	beforeEach({ msw }) {
		msw.use(
			http.get(`${API}/workspaces/:workspace/chats/activity`, () => HttpResponse.json(feed)),
			...appHandlers(),
		);
	},
	render: () => <StoryApp path={`/${storyWorkspace.slug}/activity`} />,
});

/**
 * What is unread, newest first: mentions, messages, routine runs and
 * collaborations together, each with its pod and when; the sidebar's Inbox
 * counts what is unread.
 */
export const Default = meta.story({
	play: async ({ canvas }) => {
		await expect(
			await canvas.findByText(/can you sign off the Acme quote/, {}, { timeout: 10_000 }),
		).toBeInTheDocument();
		await expect(canvas.queryByText(/that fixed it/)).toBeNull();
		const inbox = canvas.getByRole("link", { name: /^Inbox/ });
		await expect(inbox).toHaveAttribute("aria-current", "page");
		await expect(inbox).toHaveTextContent("3 unread");
	},
});

/** Turning Unread only off shows what has been read too, greyer and without its dot. */
export const All = meta.story({
	play: async ({ canvas }) => {
		const unreadOnly = await canvas.findByRole(
			"button",
			{ name: "Unread only" },
			{ timeout: 10_000 },
		);
		await expect(unreadOnly).toHaveAttribute("aria-pressed", "true");
		await userEvent.click(unreadOnly);
		await expect(await canvas.findByText(/that fixed it/)).toBeVisible();
		await expect(canvas.getByText(/can you sign off the Acme quote/)).toBeVisible();
	},
});

/**
 * The filter menu narrows it to the kinds ticked, several at once, until they
 * are unticked.
 */
export const Filtered = meta.story({
	play: async ({ canvas }) => {
		await userEvent.click(
			await canvas.findByRole("button", { name: "Filter" }, { timeout: 10_000 }),
		);
		await userEvent.click(await screen.findByRole("menuitemcheckbox", { name: /^Mentions/ }));
		await userEvent.click(await screen.findByRole("menuitemcheckbox", { name: /^Routines/ }));
		await userEvent.keyboard("{Escape}");
		const inbox = canvas.getByRole("region", { name: "Inbox" });
		await expect(within(inbox).getAllByRole("listitem")).toHaveLength(2);
		await userEvent.click(canvas.getByRole("button", { name: "Filter" }));
		await userEvent.click(await screen.findByRole("menuitemcheckbox", { name: /^Routines/ }));
		await userEvent.keyboard("{Escape}");
		await expect(within(inbox).getAllByRole("listitem")).toHaveLength(1);
		await expect(within(inbox).getByText(/can you sign off the Acme quote/)).toBeVisible();
	},
});

/** On a phone the filter is a sheet, ticking the kinds to show. */
export const FilteredOnAPhone = meta.story({
	globals: { viewport: { value: "iphone12", isRotated: false } },
	play: async ({ canvas }) => {
		await userEvent.click(
			await canvas.findByRole("button", { name: "Filter" }, { timeout: 10_000 }),
		);
		const sheet = await screen.findByRole("dialog", { name: "Show in inbox" });
		await userEvent.click(within(sheet).getByRole("checkbox", { name: /^Mentions/ }));
		await expect(within(sheet).getByRole("checkbox", { name: /^Mentions/ })).toBeChecked();
		await userEvent.keyboard("{Escape}");
		const inbox = canvas.getByRole("region", { name: "Inbox" });
		await expect(within(inbox).getAllByRole("listitem")).toHaveLength(1);
	},
});

/** Mark all as read reads every conversation with something unread, and Inbox is caught up. */
export const MarkAllAsRead = meta.story({
	beforeEach({ msw }) {
		const read = new Set<string>();
		msw.use(
			http.get(`${API}/workspaces/:workspace/chats/activity`, () =>
				HttpResponse.json({
					items: feed.items.map((item) =>
						read.has(item.conversationId) ? { ...item, unread: false } : item,
					),
				}),
			),
			http.post(`${API}/conversations/:conversationId/read`, ({ params }) => {
				read.add(String(params.conversationId));
				return new HttpResponse(null, { status: 204 });
			}),
		);
	},
	play: async ({ canvas, userEvent }) => {
		await userEvent.click(
			await canvas.findByRole("button", { name: "Mark all as read" }, { timeout: 10_000 }),
		);
		await expect(await canvas.findByText("You're all caught up.")).toBeVisible();
		await expect(canvas.queryByRole("button", { name: "Mark all as read" })).toBeNull();
	},
});

/** With nothing unread, Inbox says you are caught up. */
export const CaughtUp = meta.story({
	beforeEach({ msw }) {
		msw.use(
			http.get(`${API}/workspaces/:workspace/chats/activity`, () =>
				HttpResponse.json({ items: feed.items.map((item) => ({ ...item, unread: false })) }),
			),
		);
	},
	play: async ({ canvas }) => {
		await expect(
			await canvas.findByText("You're all caught up.", {}, { timeout: 10_000 }),
		).toBeVisible();
	},
});

/** A long chat, so a jump to an early message has somewhere to scroll. */
const longChat: Message[] = Array.from({ length: 30 }, (_, index) => {
	const text =
		index === 4
			? "@ryan-eyes can you sign off the Acme quote before 5?"
			: `Update ${index + 1} on the Northwind accounts.`;
	return {
		id: `0199a3a0-0000-7000-8000-0000000009${String(index).padStart(2, "0")}`,
		threadId: storyConversationFor(growthDesk).id,
		author:
			index === 4
				? testPerson({ id: "0199a3a0-0000-7000-8000-000000000011", name: "Jay Yu" })
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
		createdAt: new Date(Date.now() - (30 - index) * 5 * 60_000).toISOString(),
	};
});
const mentionInLongChat = "0199a3a0-0000-7000-8000-000000000904";

/**
 * Choosing a row opens its chat beside the list, which marks the row, jumped
 * to the message and pointing it out for a moment, with a way to the chat
 * itself.
 */
export const Opened = meta.story({
	beforeEach({ msw }) {
		msw.use(
			http.get(`${API}/workspaces/:workspace/chats/activity`, () =>
				HttpResponse.json({
					items: [
						{ ...(feed.items[0] as MessageItem), messageId: mentionInLongChat },
						...feed.items.slice(1),
					],
				}),
			),
			...appHandlers({ messages: { [growthDesk.id]: longChat } }),
		);
	},
	render: () => (
		<StoryApp
			path={`/${storyWorkspace.slug}/activity/${revenue.slug}/${storyConversationFor(growthDesk).id}?message=${mentionInLongChat}`}
		/>
	),
	play: async ({ canvas }) => {
		await expect(
			await canvas.findByRole("link", { name: "Open thread" }, { timeout: 10_000 }),
		).toBeVisible();
		const inbox = canvas.getByRole("region", { name: "Inbox" });
		await expect(
			await within(inbox).findByRole("link", { name: /Jay Yu mentioned you/ }),
		).toHaveAttribute("aria-current", "page");
	},
});

/** More unread messages than fit, as a busy workspace has. */
const longFeed: ActivityFeed = {
	items: Array.from({ length: 40 }, (_, index) => ({
		...(feed.items[1] as MessageItem),
		messageId: `0199a3a0-0000-7000-8000-000000000a${String(index).padStart(2, "0")}`,
		preview: `Renewal notes ${index + 1} are ready.`,
		at: minutesAgo(index * 10),
	})),
};

/** A feed longer than the window scrolls within the page, and the window itself stays put. */
export const LongFeed = meta.story({
	beforeEach({ msw }) {
		msw.use(
			http.get(`${API}/workspaces/:workspace/chats/activity`, () => HttpResponse.json(longFeed)),
		);
	},
	play: async ({ canvas, canvasElement }) => {
		await expect(
			await canvas.findByText("Renewal notes 40 are ready.", {}, { timeout: 10_000 }),
		).toBeInTheDocument();
		const page = canvasElement.ownerDocument.documentElement;
		await expect(page.scrollHeight).toBeLessThanOrEqual(page.clientHeight);
	},
});
