import { expect, fn } from "storybook/test";
import preview from "#storybook/preview";
import { storyChatFor } from "@/story-app.tsx";
import { ConversationListView, type ConversationRowData } from "./ConversationList.tsx";
import { accountManager, design, growthDesk, leadResearcher, revenue } from "./story-fixtures.ts";

const minutesAgo = (minutes: number) => new Date(Date.now() - minutes * 60_000).toISOString();
const daysAgo = (days: number) => new Date(Date.now() - days * 24 * 60 * 60_000).toISOString();

const revenueRows: ConversationRowData[] = [
	{
		agent: growthDesk,
		chat: storyChatFor(growthDesk),
		fromYou: false,
		unread: true,
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
		fromYou: false,
		unread: true,
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
		fromYou: true,
		unread: false,
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

/** Default is a pod's chats, newest first, with the open one marked and a way to its settings. */
export const Default = meta.story({
	play: async ({ canvas }) => {
		await expect(canvas.getByRole("link", { name: "Pod settings" })).toHaveAttribute(
			"href",
			expect.stringMatching(/\/settings\/pods\/revenue$/),
		);
	},
});

/**
 * A chat waiting for your decision carries a hand on its face and says what it
 * waits to do; one with something new a dot, with its name and preview
 * brighter. The hand wins when both apply.
 */
export const UnreadAndWaiting = meta.story({
	args: { selectedAgentId: leadResearcher.id },
	play: async ({ canvas }) => {
		await expect(canvas.getByRole("link", { name: /Growth Desk/ })).toHaveTextContent(
			"Needs your approval",
		);
		await expect(canvas.getByText("Waiting to send email in Gmail")).toBeVisible();
		await expect(canvas.getByRole("link", { name: /Growth Desk/ })).not.toHaveTextContent("Unread");
		await expect(canvas.getByRole("link", { name: /Account Manager/ })).toHaveTextContent("Unread");
		await expect(canvas.getByRole("link", { name: /Lead Researcher/ })).not.toHaveTextContent(
			"Unread",
		);
	},
});

/** Search narrows the rows to bots whose names match. */
export const Search = meta.story({
	play: async ({ canvas, userEvent }) => {
		await userEvent.type(canvas.getByRole("searchbox", { name: "Search Revenue" }), "lead");
		await expect(canvas.getAllByRole("listitem")).toHaveLength(1);
		await expect(canvas.getByRole("link", { name: /Lead Researcher/ })).toBeVisible();
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
