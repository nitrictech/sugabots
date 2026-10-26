import type { ChatListItem } from "@sugabots/contracts";
import { expect, fn } from "storybook/test";
import preview from "#storybook/preview";
import { storyConversationFor } from "@/story-app.tsx";
import { ConversationListView } from "./ConversationList.tsx";
import { accountManager, design, growthDesk, leadResearcher, revenue } from "./story-fixtures.ts";

const minutesAgo = (minutes: number) => new Date(Date.now() - minutes * 60_000).toISOString();
const daysAgo = (days: number) => new Date(Date.now() - days * 24 * 60 * 60_000).toISOString();

const revenueRows: ChatListItem[] = [
	{
		agent: growthDesk,
		conversation: storyConversationFor(growthDesk),
		unreadMessages: 1,
		needsApproval: true,
		mentionsYou: false,
		lastMessage: {
			preview: "I'll send the outreach emails now:",
			authorUserId: null,
			at: minutesAgo(3),
		},
		waitingOn: "gmail__send_email",
	},
	{
		agent: accountManager,
		conversation: storyConversationFor(accountManager),
		unreadMessages: 3,
		needsApproval: false,
		mentionsYou: false,
		lastMessage: {
			preview: "Renewal notes for Halcyon are ready",
			authorUserId: null,
			at: daysAgo(1),
		},
		waitingOn: null,
	},
	{
		agent: leadResearcher,
		conversation: storyConversationFor(leadResearcher),
		unreadMessages: 0,
		needsApproval: false,
		mentionsYou: false,
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
		hasBots: true,
		selected: { kind: "thread" as const, conversationId: storyConversationFor(growthDesk).id },
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
	args: { selected: { kind: "thread", conversationId: storyConversationFor(leadResearcher).id } },
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
		hasBots: false,
		selected: undefined,
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
		hasBots: false,
		selected: undefined,
		onNewBot: undefined,
		emptyState: { title: "No bots in Design yet", hint: "Someone who runs this pod can add one." },
	},
	play: async ({ canvas }) => {
		await expect(canvas.getByText("Someone who runs this pod can add one.")).toBeVisible();
		await expect(canvas.queryByRole("button", { name: "New bot" })).toBeNull();
	},
});

const revenueChat = {
	conversation: {
		...storyConversationFor(growthDesk),
		id: "0199a3a0-0000-7000-8000-00000000c900",
		hostAgentId: null,
		title: "Pod chat",
		doneAt: null,
	},
	unreadMessages: 2,
};

/**
 * A shared pod's chat sits above its threads: open here, and counting what is
 * new in it when it is not.
 */
export const PodChat = meta.story({
	args: { podChat: revenueChat, selected: { kind: "podChat" } },
	play: async ({ canvas }) => {
		const chat = canvas.getByRole("link", { name: /Pod chat/ });
		await expect(chat).toHaveAttribute("aria-current", "page");
		await expect(chat).toHaveTextContent("2 unread messages");
		await expect(canvas.getByText("Threads")).toBeVisible();
	},
});

/** A pod whose chat nobody has opened yet still offers it, and opens it from its own address. */
export const PodChatUnopened = meta.story({
	args: { podChat: "unopened", rows: [] },
	play: async ({ canvas }) => {
		await expect(canvas.getByRole("link", { name: /Pod chat/ })).toHaveAttribute(
			"href",
			expect.stringMatching(/\/pods\/revenue\/chat$/),
		);
		await expect(canvas.queryByText("Threads")).toBeNull();
	},
});

/** A thread between people has no bot's face, and is called what it was started with. */
export const PeopleThread = meta.story({
	args: {
		podChat: revenueChat,
		rows: [
			{
				agent: null,
				conversation: {
					...storyConversationFor(growthDesk),
					id: "0199a3a0-0000-7000-8000-00000000c950",
					hostAgentId: null,
					title: "Who's covering Halcyon next week?",
				},
				unreadMessages: 0,
				needsApproval: false,
				mentionsYou: false,
				lastMessage: null,
				waitingOn: null,
			},
			...revenueRows,
		],
	},
	play: async ({ canvas }) => {
		await expect(
			canvas.getByRole("link", { name: /Who's covering Halcyon next week\?/ }),
		).toBeVisible();
	},
});

/**
 * Threads marked done fold away under Done, counted, and come back in dimmer
 * when it is opened. A thread with a message that mentions you shows a dot.
 */
export const DoneAndMentioned = meta.story({
	args: {
		podChat: revenueChat,
		rows: [
			{ ...(revenueRows[0] as ChatListItem), needsApproval: false, mentionsYou: true },
			{
				...(revenueRows[1] as ChatListItem),
				conversation: {
					...(revenueRows[1] as ChatListItem).conversation,
					doneAt: "2026-09-18T07:00:00.000Z",
				},
			},
		],
	},
	play: async ({ canvas, userEvent }) => {
		await expect(canvas.getByRole("link", { name: /Growth Desk/ })).toHaveTextContent("Needs you");
		await expect(canvas.queryByRole("link", { name: /Account Manager/ })).toBeNull();
		await userEvent.click(canvas.getByRole("button", { name: /Done/ }));
		await expect(canvas.getByRole("link", { name: /Account Manager/ })).toBeVisible();
	},
});

/** A pod's routines fold away under their own heading; one paused says so when it is opened. */
export const Routines = meta.story({
	args: {
		podChat: revenueChat,
		routines: [
			{
				routine: {
					id: "0199a3a0-0000-7000-8000-0000000003a1",
					name: "Overnight outbound",
					state: "enabled",
				},
				agent: growthDesk,
				conversation: null,
				mentionsYou: false,
			},
			{
				routine: {
					id: "0199a3a0-0000-7000-8000-0000000003a2",
					name: "Inbox triage",
					state: "paused",
				},
				agent: accountManager,
				conversation: null,
				mentionsYou: false,
			},
		],
	},
	play: async ({ canvas, userEvent }) => {
		await expect(canvas.queryByRole("link", { name: /Overnight outbound/ })).toBeNull();
		await userEvent.click(canvas.getByRole("button", { name: /Routines/ }));
		await expect(canvas.getByRole("link", { name: /Overnight outbound/ })).toHaveAttribute(
			"href",
			expect.stringMatching(/\/pods\/revenue\/routines\/0199a3a0-0000-7000-8000-0000000003a1$/),
		);
		await expect(canvas.getByRole("link", { name: /Inbox triage/ })).toHaveTextContent("Paused");
	},
});

/** Failed says the chats could not be loaded. */
export const Failed = meta.story({ args: { rows: [], status: "failed" as const } });
