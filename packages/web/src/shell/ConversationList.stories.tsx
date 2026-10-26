import type { ChatListItem } from "@sugabots/contracts";
import { expect, fn, screen } from "storybook/test";
import preview from "#storybook/preview";
import { storyConversationFor, storyPodChatFor } from "@/story-app.tsx";
import { ConversationListView } from "./ConversationList.tsx";
import {
	accountManager,
	chief,
	design,
	growthDesk,
	leadResearcher,
	personal,
	revenue,
} from "./story-fixtures.ts";

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
		routines: [],
		status: "ready" as const,
		hasBots: true,
		grouping: "bot" as const,
		onGroupingChange: fn(),
		selected: {
			kind: "conversation" as const,
			conversationId: storyConversationFor(growthDesk).id,
		},
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

/** Default is a pod's threads under their bots, one line each, with the open one marked, and a way to its settings. */
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
	args: {
		grouping: "recent",
		selected: { kind: "conversation", conversationId: storyConversationFor(leadResearcher).id },
	},
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
	conversation: { ...storyPodChatFor(revenue), id: "0199a3a0-0000-7000-8000-00000000c900" },
	unreadMessages: 2,
};

const pricingChat = {
	conversation: {
		...revenueChat.conversation,
		id: "0199a3a0-0000-7000-8000-00000000c901",
		title: "Pricing",
		main: false,
	},
	unreadMessages: 0,
};

/**
 * A shared pod's chat sits above its threads: open here, and counting what is
 * new in it when it is not.
 */
export const PodChat = meta.story({
	args: {
		grouping: "recent",
		chats: { list: [revenueChat], onNew: fn() },
		selected: { kind: "podChat" },
	},
	play: async ({ canvas }) => {
		const chat = canvas.getByRole("link", { name: /^General/ });
		await expect(chat).toHaveAttribute("aria-current", "page");
		await expect(chat).toHaveTextContent("2 unread messages");
		await expect(canvas.getByText("Active threads")).toBeVisible();
	},
});

/** A pod whose chat nobody has opened yet still offers it, and opens it from its own address. */
export const PodChatUnopened = meta.story({
	args: { chats: { list: [], onNew: fn() }, rows: [] },
	play: async ({ canvas }) => {
		await expect(canvas.getByRole("link", { name: /^General/ })).toHaveAttribute(
			"href",
			expect.stringMatching(/\/pods\/revenue\/chat$/),
		);
		await expect(canvas.queryByText("Active threads")).toBeNull();
	},
});

const newChat = fn();

/**
 * A pod with more than one chat lists them under Chats, its first named for
 * the pod, with + to start another; the one open is marked.
 */
export const SeveralChats = meta.story({
	args: {
		chats: { list: [revenueChat, pricingChat], onNew: newChat },
		selected: { kind: "conversation", conversationId: pricingChat.conversation.id },
	},
	play: async ({ canvas, userEvent }) => {
		const pricing = canvas.getByRole("link", { name: /^Pricing/ });
		await expect(pricing).toHaveAttribute("aria-current", "page");
		await expect(canvas.getByRole("link", { name: /^General/ })).not.toHaveAttribute(
			"aria-current",
		);
		await userEvent.click(canvas.getByRole("button", { name: `New chat in ${revenue.name}` }));
		await expect(newChat).toHaveBeenCalledOnce();
	},
});

/** A thread between people has no bot's face, and is called what it was started with. */
export const PeopleThread = meta.story({
	args: {
		chats: { list: [revenueChat], onNew: fn() },
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
		grouping: "recent",
		chats: { list: [revenueChat], onNew: fn() },
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

/** A pod's routines fold away under their own heading; one paused looks the same, and says so to a screen reader. */
export const Routines = meta.story({
	args: {
		grouping: "recent",
		chats: { list: [revenueChat], onNew: fn() },
		routines: [
			{
				routine: {
					id: "0199a3a0-0000-7000-8000-0000000003a1",
					name: "Overnight outbound",
					state: "enabled",
					failed: false,
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
					failed: false,
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

/** A routine whose latest run failed opens the Routines section by itself, with a red dot. */
export const FailedRoutine = meta.story({
	args: {
		chats: { list: [revenueChat], onNew: fn() },
		routines: [
			{
				routine: {
					id: "0199a3a0-0000-7000-8000-0000000003a3",
					name: "Overnight outbound",
					state: "enabled",
					failed: true,
				},
				agent: growthDesk,
				conversation: null,
				mentionsYou: false,
			},
		],
	},
	play: async ({ canvas }) => {
		await expect(canvas.getByRole("link", { name: /Overnight outbound/ })).toHaveTextContent(
			"Failed",
		);
	},
});

/**
 * A Personal pod lists each conversation by its bot's name, with no Done
 * section: one marked done before stays among the rest.
 */
export const PersonalPod = meta.story({
	args: {
		pod: personal,
		selected: undefined,
		rows: [
			{
				agent: chief,
				conversation: { ...storyConversationFor(chief), doneAt: "2026-09-18T07:00:00.000Z" },
				unreadMessages: 0,
				needsApproval: false,
				mentionsYou: false,
				lastMessage: null,
				waitingOn: null,
			},
		],
	},
	play: async ({ canvas }) => {
		await expect(canvas.getByRole("link", { name: chief.name })).toBeVisible();
		await expect(canvas.queryByText(`Conversation with ${chief.name}`)).toBeNull();
		await expect(canvas.queryByRole("button", { name: /Done/ })).toBeNull();
	},
});

const groupingChange = fn();

/**
 * By bot puts each bot's open threads under its face and name, then its
 * routines, marked at their end, with threads between people last. A bot's
 * heading folds its rows away, the one holding the open thread too; its +
 * starts a thread with it.
 */
export const ByBot = meta.story({
	// The sections it folds are remembered, so each run starts with them all open.
	beforeEach: () => localStorage.removeItem(`sugabots-folded-bots:${revenue.id}`),
	args: {
		chats: { list: [revenueChat], onNew: fn() },
		grouping: "bot",
		onGroupingChange: groupingChange,
		selected: { kind: "conversation", conversationId: storyConversationFor(leadResearcher).id },
		rows: [
			...revenueRows,
			{
				...(revenueRows[0] as ChatListItem),
				conversation: {
					...(revenueRows[0] as ChatListItem).conversation,
					id: "0199a3a0-0000-7000-8000-00000000c960",
					title: "Follow up with Halcyon",
				},
				needsApproval: false,
				unreadMessages: 0,
			},
			{
				agent: null,
				conversation: {
					...storyConversationFor(growthDesk),
					id: "0199a3a0-0000-7000-8000-00000000c961",
					hostAgentId: null,
					title: "Who's covering Halcyon next week?",
				},
				unreadMessages: 0,
				needsApproval: false,
				mentionsYou: false,
				lastMessage: null,
				waitingOn: null,
			},
		],
		routines: [
			{
				routine: {
					id: "0199a3a0-0000-7000-8000-0000000003a4",
					name: "Overnight outbound",
					state: "enabled",
					failed: false,
				},
				agent: growthDesk,
				conversation: null,
				mentionsYou: false,
			},
		],
	},
	play: async ({ canvas, userEvent }) => {
		const headings = canvas
			.getAllByRole("button", { expanded: true })
			.map((heading) => heading.textContent);
		await expect(headings).toEqual([
			accountManager.name,
			growthDesk.name,
			leadResearcher.name,
			"People",
		]);
		await expect(canvas.queryByText("Active threads")).toBeNull();
		await expect(canvas.getByRole("link", { name: /Overnight outbound/ })).toBeVisible();

		await userEvent.click(canvas.getByRole("button", { name: growthDesk.name }));
		await expect(canvas.queryByRole("link", { name: /Overnight outbound/ })).toBeNull();
		await expect(canvas.getByRole("button", { name: growthDesk.name })).toHaveAttribute(
			"aria-expanded",
			"false",
		);
		await userEvent.click(canvas.getByRole("button", { name: leadResearcher.name }));
		await expect(canvas.getByRole("button", { name: /Lead Researcher/ })).toHaveAttribute(
			"aria-expanded",
			"false",
		);
		await expect(
			canvas.queryByRole("link", { name: /Conversation with Lead Researcher/ }),
		).toBeNull();

		await expect(
			canvas.getByRole("link", { name: `New thread with ${leadResearcher.name}` }),
		).toHaveAttribute(
			"href",
			expect.stringMatching(
				new RegExp(`/pods/revenue/threads/new\\?agent=${leadResearcher.handle}$`),
			),
		);

		await userEvent.click(canvas.getByRole("button", { name: "Group threads" }));
		await userEvent.click(await screen.findByRole("menuitemradio", { name: "Most recent" }));
		await expect(groupingChange).toHaveBeenCalledWith("recent");
	},
});

/**
 * A thread opened in a folded section shows it open, so the viewer can see
 * where they are, and its heading still folds it.
 */
export const ByBotOpenThreadInAFoldedSection = meta.story({
	beforeEach: () =>
		localStorage.setItem(`sugabots-folded-bots:${revenue.id}`, JSON.stringify([leadResearcher.id])),
	args: ByBot.input.args,
	play: async ({ canvas, userEvent }) => {
		const heading = canvas.getByRole("button", { name: leadResearcher.name });
		await expect(heading).toHaveAttribute("aria-expanded", "true");
		await expect(
			canvas.getByRole("link", { name: /Conversation with Lead Researcher/ }),
		).toBeVisible();

		await userEvent.click(heading);
		await expect(canvas.getByRole("button", { name: /Lead Researcher/ })).toHaveAttribute(
			"aria-expanded",
			"false",
		);
		await expect(
			canvas.queryByRole("link", { name: /Conversation with Lead Researcher/ }),
		).toBeNull();
	},
});

const accountManagerThreads: ChatListItem[] = [
	"Halcyon renewal notes",
	"Northwind pricing",
	"Q4 forecast",
	"Churn interviews summary",
	"Onboarding email audit",
	"Pricing page teardown",
].map((title, index) => ({
	...(revenueRows[1] as ChatListItem),
	conversation: {
		...(revenueRows[1] as ChatListItem).conversation,
		id: `0199a3a0-0000-7000-8000-00000000d${String(index).padStart(3, "0")}`,
		title,
	},
	unreadMessages: 0,
}));

/**
 * A bot's section shows its first four rows, and the open one wherever it is,
 * then how many more there are. Done threads sit last under their own
 * heading, with their bots' faces faded.
 */
export const ByBotShowMore = meta.story({
	args: {
		grouping: "bot",
		selected: {
			kind: "conversation",
			conversationId: (accountManagerThreads[5] as ChatListItem).conversation.id,
		},
		rows: [
			...accountManagerThreads,
			{
				...(revenueRows[0] as ChatListItem),
				conversation: {
					...(revenueRows[0] as ChatListItem).conversation,
					doneAt: "2026-09-18T07:00:00.000Z",
				},
			},
		],
	},
	play: async ({ canvas, userEvent }) => {
		await expect(canvas.getByRole("link", { name: /Churn interviews summary/ })).toBeVisible();
		await expect(canvas.queryByRole("link", { name: /Onboarding email audit/ })).toBeNull();
		await expect(canvas.getByRole("link", { name: /Pricing page teardown/ })).toBeVisible();
		await userEvent.click(canvas.getByRole("button", { name: "Show 1 more" }));
		await expect(canvas.getByRole("link", { name: /Onboarding email audit/ })).toBeVisible();

		await expect(canvas.queryByRole("link", { name: /Growth Desk/ })).toBeNull();
		await userEvent.click(canvas.getByRole("button", { name: /Done/ }));
		await expect(canvas.getByRole("link", { name: /Growth Desk/ })).toBeVisible();
	},
});

/** Failed says the chats could not be loaded. */
export const Failed = meta.story({ args: { rows: [], status: "failed" as const } });
