import type { ChatListItem } from "@sugabots/contracts";
import { expect, fn } from "storybook/test";
import preview from "#storybook/preview";
import { storyChatFor } from "@/story-app.tsx";
import { ConversationListView } from "./ConversationList.tsx";
import { accountManager, design, growthDesk, leadResearcher, revenue } from "./story-fixtures.ts";

const minutesAgo = (minutes: number) => new Date(Date.now() - minutes * 60_000).toISOString();
const daysAgo = (days: number) => new Date(Date.now() - days * 24 * 60 * 60_000).toISOString();

const revenueRows: ChatListItem[] = [
	{
		agent: growthDesk,
		chat: storyChatFor(growthDesk),
		unreadMessages: 1,
		needsApproval: true,
		lastMessage: {
			preview: "I'll send the outreach emails now:",
			authorUserId: null,
			at: minutesAgo(3),
		},
		waitingOn: "gmail__send_email",
	},
	{
		agent: accountManager,
		chat: storyChatFor(accountManager),
		unreadMessages: 3,
		needsApproval: false,
		lastMessage: {
			preview: "Renewal notes for Halcyon are ready",
			authorUserId: null,
			at: daysAgo(1),
		},
		waitingOn: null,
	},
	{
		agent: leadResearcher,
		chat: storyChatFor(leadResearcher),
		unreadMessages: 0,
		needsApproval: false,
		lastMessage: {
			preview: "Go deeper on the fintech prospects from last week's list",
			authorUserId: "0199a3a0-0000-7000-8000-000000000009",
			at: daysAgo(3),
		},
		waitingOn: null,
	},
];

const meta = preview.meta({
	title: "Product/ConversationList",
	component: ConversationListView,
	tags: ["ai-generated"],
	parameters: { layout: "fullscreen" },
	args: {
		pod: revenue,
		rows: revenueRows,
		status: "ready" as const,
		selectedAgentId: growthDesk.id,
		onNewBot: fn(),
		emptyState: { title: "No bots in Revenue yet" },
	},
	decorators: [
		(Story) => (
			<div className="flex h-[640px]">
				<Story />
			</div>
		),
	],
});

/** Default is a pod's chats, newest first, one line each, with the open one marked, a New bot at the foot, and a way to its settings. */
export const Default = meta.story({
	play: async ({ canvas }) => {
		await expect(canvas.getByRole("link", { name: "Pod settings" })).toHaveAttribute(
			"href",
			expect.stringMatching(/\/settings\/pods\/revenue$/),
		);
	},
});

/**
 * A chat waiting for your decision says it needs you; one with something new
 * counts its unread messages. Both make the name brighter, and Needs you wins
 * when both apply.
 */
export const UnreadAndWaiting = meta.story({
	args: { selectedAgentId: leadResearcher.id },
	play: async ({ canvas }) => {
		const growth = canvas.getByRole("link", { name: /Growth Desk/ });
		await expect(growth).toHaveTextContent("Needs you");
		await expect(growth).not.toHaveTextContent("unread");
		await expect(canvas.getByRole("link", { name: /Account Manager/ })).toHaveTextContent(
			"3 unread messages",
		);
		await expect(canvas.getByRole("link", { name: /Lead Researcher/ })).not.toHaveTextContent(
			"unread",
		);
	},
});

const newBot = fn();

/** EmptyPod is a new pod with no bots: one message and one way forward. */
export const EmptyPod = meta.story({
	args: {
		pod: design,
		rows: [],
		selectedAgentId: undefined,
		emptyState: { title: "No bots in Design yet", action: { label: "New bot", onClick: newBot } },
	},
	play: async ({ canvas, userEvent }) => {
		await expect(canvas.getByText("No bots in Design yet")).toBeVisible();
		await userEvent.click(canvas.getByRole("button", { name: "New bot" }));
		await expect(newBot).toHaveBeenCalled();
	},
});

/** A pod somebody may only read: it says who can add a bot, rather than leaving nothing to do. */
export const EmptyPodForAMember = meta.story({
	args: {
		pod: design,
		rows: [],
		selectedAgentId: undefined,
		onNewBot: undefined,
		emptyState: { title: "No bots in Design yet", hint: "Someone who runs this pod can add one." },
	},
	play: async ({ canvas }) => {
		await expect(canvas.getByText("Someone who runs this pod can add one.")).toBeVisible();
		await expect(canvas.queryByRole("button", { name: "New bot" })).toBeNull();
	},
});

/** Failed says the chats could not be loaded. */
export const Failed = meta.story({ args: { rows: [], status: "failed" as const } });
