import { expect, fn } from "storybook/test";
import preview from "#storybook/preview";
import { ConversationListView, type ConversationRowData } from "./ConversationList.tsx";
import {
	accountManager,
	engineering,
	growthDesk,
	leadResearcher,
	linearHandler,
	oncall,
	revenue,
} from "./story-fixtures.ts";

const minutesAgo = (minutes: number) => new Date(Date.now() - minutes * 60_000).toISOString();
const daysAgo = (days: number) => new Date(Date.now() - days * 24 * 60 * 60_000).toISOString();

const revenueBots = [growthDesk, accountManager, leadResearcher];
const engineeringBots = [linearHandler, oncall];

const revenueRows: ConversationRowData[] = [
	{
		agent: growthDesk,
		pod: revenue,
		podBots: revenueBots,
		chatId: null,
		fromYou: false,
		lastMessage: { preview: "Needs your approval", authorUserId: null, at: minutesAgo(3) },
	},
	{
		agent: accountManager,
		pod: revenue,
		podBots: revenueBots,
		chatId: null,
		fromYou: false,
		lastMessage: {
			preview: "Renewal notes for Halcyon are ready",
			authorUserId: null,
			at: daysAgo(1),
		},
	},
	{
		agent: leadResearcher,
		pod: revenue,
		podBots: revenueBots,
		chatId: null,
		fromYou: true,
		lastMessage: {
			preview: "Go deeper on the fintech prospects from last week's list",
			authorUserId: "0199a3a0-0000-7000-8000-000000000009",
			at: daysAgo(3),
		},
	},
];

const allRows: ConversationRowData[] = [
	...revenueRows.slice(0, 1),
	{
		agent: linearHandler,
		pod: engineering,
		podBots: engineeringBots,
		chatId: null,
		fromYou: false,
		lastMessage: {
			preview: "Filed PLAT-482 for the timeout",
			authorUserId: null,
			at: minutesAgo(40),
		},
	},
	...revenueRows.slice(1),
];

const meta = preview.meta({
	title: "Product/ConversationList",
	component: ConversationListView,
	tags: ["ai-generated"],
	parameters: { layout: "fullscreen" },
	args: {
		title: "Revenue",
		inAll: false,
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

/** Default is a pod's chats, newest first, with the open one marked. */
export const Default = meta.story({});

/** All shows every shared pod's chats, each face carrying its pod's badge. */
export const All = meta.story({
	args: { title: "All", inAll: true, rows: allRows, onNewBot: undefined },
});

/** Search narrows the rows to bots whose names match. */
export const Search = meta.story({
	play: async ({ canvas, userEvent }) => {
		await userEvent.type(canvas.getByRole("searchbox", { name: "Search Revenue" }), "lead");
		await expect(canvas.getAllByRole("link")).toHaveLength(1);
		await expect(canvas.getByRole("link", { name: /Lead Researcher/ })).toBeVisible();
	},
});

const newBot = fn();

/** EmptyPod is a new pod with no bots: one message and one way forward. */
export const EmptyPod = meta.story({
	args: {
		title: "Design",
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
		title: "Design",
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

const newPod = fn();

/** All, before there is a shared pod: the next step is making one. */
export const NoPodsYet = meta.story({
	args: {
		title: "All",
		inAll: true,
		rows: [],
		selectedAgentId: undefined,
		onNewBot: undefined,
		emptyState: {
			title: "No pods yet",
			hint: "A pod is where a team's bots live. Make one to start.",
			action: { label: "New pod", onClick: newPod },
		},
	},
	play: async ({ canvas, userEvent }) => {
		await userEvent.click(canvas.getByRole("button", { name: "New pod" }));
		await expect(newPod).toHaveBeenCalled();
	},
});

/** Failed says the chats could not be loaded. */
export const Failed = meta.story({ args: { rows: [], status: "failed" as const } });
