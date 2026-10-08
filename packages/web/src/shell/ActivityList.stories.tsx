import type { ActivityFeed, ActivityItem, Message } from "@sugabots/contracts";
import { testPerson } from "@sugabots/contracts/testing";
import { HttpResponse, http } from "msw";
import { expect, userEvent } from "storybook/test";
import preview from "#storybook/preview";
import { accountManager, growthDesk, revenue } from "@/shell/story-fixtures.ts";
import { appHandlers, StoryApp, storyChatFor, storyWorkspace } from "@/story-app.tsx";

/*
 * What is new across the workspace's chats, opened from the rail: mentions of
 * you, read or not, messages you have not read, routine runs and
 * collaborations. A message opens its chat; a run or collaboration opens as a
 * page of its own.
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
			chatAgentId: growthDesk.id,
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
			},
			preview: "Renewal notes for Halcyon are ready.",
			at: minutesAgo(40),
			podId: revenue.id,
			chatAgentId: accountManager.id,
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
			},
			at: minutesAgo(90),
			unread: true,
			podId: revenue.id,
			chatAgentId: growthDesk.id,
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
			},
			recipient: {
				kind: "agent",
				id: accountManager.id,
				name: accountManager.name,
				handle: accountManager.handle,
				color: accountManager.color,
				face: accountManager.face,
			},
			status: "pending",
			brief: "Check whether Acme can have 25% off the annual tier.",
			at: minutesAgo(120),
			unread: false,
			podId: revenue.id,
			chatAgentId: growthDesk.id,
		},
		{
			kind: "mention",
			unread: false,
			messageId: "0199a3a0-0000-7000-8000-000000000803",
			author: testPerson({ id: "0199a3a0-0000-7000-8000-000000000012", name: "Priya Kaur" }),
			preview: "Thanks @ryan-eyes, that fixed it.",
			at: minutesAgo(26 * 60),
			podId: revenue.id,
			chatAgentId: growthDesk.id,
		},
	],
};

const meta = preview.meta({
	title: "Views/Activity",
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

/** Mentions, unread messages, routine runs and collaborations together, newest first, beside an empty pane until one is chosen; the rail counts the unread mention. */
export const Default = meta.story({
	play: async ({ canvas }) => {
		await expect(
			await canvas.findByText(/can you sign off the Acme quote/, {}, { timeout: 10_000 }),
		).toBeInTheDocument();
		await expect(canvas.getByRole("link", { name: "Activity, 1 unread mention" })).toHaveAttribute(
			"aria-current",
			"page",
		);
	},
});

/** Mentions alone, read and unread. */
export const Mentions = meta.story({
	play: async ({ canvas }) => {
		await userEvent.click(
			await canvas.findByRole("tab", { name: /Mentions/ }, { timeout: 10_000 }),
		);
		await expect(canvas.queryByText(/Renewal notes/)).toBeNull();
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
		threadId: storyChatFor(growthDesk).mainThreadId,
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
 * Choosing a row opens its chat beside the list, marks the row as the open
 * one, and jumps the chat to the message, pointing it out for a moment.
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
			path={`/${storyWorkspace.slug}/activity/${revenue.slug}/${growthDesk.handle}?item=${mentionInLongChat}&message=${mentionInLongChat}`}
		/>
	),
	play: async ({ canvas }) => {
		await expect(
			await canvas.findByRole("link", { name: /Jay Yu mentioned you/ }, { timeout: 10_000 }),
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

/** A feed longer than the window scrolls within its column, and the page itself stays put. */
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
