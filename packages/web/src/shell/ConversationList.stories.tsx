import type { ChatListItem } from "@sugabots/contracts";
import { expect, fn } from "storybook/test";
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

const meta = preview.meta({
	title: "Product/ConversationList",
	component: ConversationListView,
	tags: ["ai-generated"],
	parameters: { layout: "fullscreen" },
	beforeEach: () => localStorage.removeItem(`sugabots-open-bots:${revenue.id}`),
	args: {
		pod: revenue,
		chats: { list: [revenueChat], onNew: fn() },
		bots: [accountManager, growthDesk, leadResearcher],
		rows: revenueRows,
		status: "ready" as const,
		selected: {
			kind: "conversation" as const,
			conversationId: storyConversationFor(leadResearcher).id,
		},
		onNewBot: fn(),
	},
	decorators: [
		(Story) => (
			<div className="h-[640px] w-62 overflow-y-auto border-border border-r bg-rail px-3 pt-4">
				<Story />
			</div>
		),
	],
});

/**
 * Default is a pod's chat, then its bots, each closed and counting its
 * threads, but for the one holding the open thread, which is open on it.
 */
export const Default = meta.story({
	play: async ({ canvas }) => {
		await expect(canvas.getByRole("button", { name: leadResearcher.name })).toHaveAttribute(
			"aria-expanded",
			"true",
		);
		await expect(
			canvas.getByRole("link", { name: /Conversation with Lead Researcher/ }),
		).toHaveAttribute("aria-current", "page");
		await expect(canvas.getByRole("button", { name: /^Growth Desk/ })).toHaveAttribute(
			"aria-expanded",
			"false",
		);
	},
});

/**
 * A closed bot with something new in it is brighter and counts what is unread
 * in its threads, where it otherwise counts them; opened, each thread counts
 * its unread messages, and one waiting on you says so too.
 */
export const UnreadAndWaiting = meta.story({
	play: async ({ canvas, userEvent }) => {
		const growth = canvas.getByRole("button", { name: /^Growth Desk/ });
		await expect(growth.closest("li")).toHaveTextContent("1 unread message, needs you");
		await expect(
			canvas.getByRole("button", { name: leadResearcher.name }).closest("li"),
		).not.toHaveTextContent("unread");
		await userEvent.click(growth);
		await expect(
			canvas.getByRole("link", { name: /Conversation with Growth Desk/ }),
		).toHaveTextContent("1 unread message, needs you");
		await userEvent.click(canvas.getByRole("button", { name: /^Account Manager/ }));
		await expect(
			canvas.getByRole("link", { name: /Conversation with Account Manager/ }),
		).toHaveTextContent("3 unread messages");
	},
});

/** A bot opened stays open when the page is left and come back to, on this device. */
export const OpenABot = meta.story({
	args: { selected: undefined },
	play: async ({ canvas, userEvent }) => {
		await expect(canvas.queryByRole("link", { name: /Conversation with Growth Desk/ })).toBeNull();
		await userEvent.click(canvas.getByRole("button", { name: /^Growth Desk/ }));
		await expect(canvas.getByRole("link", { name: /Conversation with Growth Desk/ })).toBeVisible();
		await expect(localStorage.getItem(`sugabots-open-bots:${revenue.id}`)).toBe(
			JSON.stringify([growthDesk.id]),
		);
	},
});

/** Closing the bot that holds the open thread closes it, though the thread stays open. */
export const CloseTheOpenThreadsBot = meta.story({
	play: async ({ canvas, userEvent }) => {
		await userEvent.click(canvas.getByRole("button", { name: leadResearcher.name }));
		await expect(canvas.getByRole("button", { name: leadResearcher.name })).toHaveAttribute(
			"aria-expanded",
			"false",
		);
		await expect(
			canvas.queryByRole("link", { name: /Conversation with Lead Researcher/ }),
		).toBeNull();
	},
});

/**
 * A bot with no thread yet is listed all the same, and opens to its Routines,
 * which it has before it runs any; its + starts a thread with it.
 */
export const BotWithNoThreads = meta.story({
	args: { rows: revenueRows.slice(0, 2), selected: undefined },
	play: async ({ canvas, userEvent }) => {
		await userEvent.click(canvas.getByRole("button", { name: leadResearcher.name }));
		await expect(canvas.getByRole("link", { name: "Routines" })).toHaveAttribute(
			"href",
			expect.stringMatching(new RegExp(`/pods/revenue/routines\\?bot=${leadResearcher.handle}$`)),
		);
		await expect(
			canvas.getByRole("link", { name: `New thread with ${leadResearcher.name}` }),
		).toHaveAttribute("href", expect.stringMatching(/\/pods\/revenue\/threads\/new\?agent=/));
	},
});

/** A bot with no thread, opened before, is not marked while something else is open. */
export const BotWithNoThreadsWhileTheChatIsOpen = meta.story({
	beforeEach: () =>
		localStorage.setItem(`sugabots-open-bots:${revenue.id}`, JSON.stringify([leadResearcher.id])),
	args: { rows: revenueRows.slice(0, 2), selected: { kind: "podChat" } },
	play: async ({ canvas }) => {
		await expect(canvas.getByRole("link", { name: /^General/ })).toHaveAttribute(
			"aria-current",
			"page",
		);
		await expect(canvas.getByRole("button", { name: leadResearcher.name })).not.toHaveAttribute(
			"aria-current",
		);
		await expect(canvas.getByRole("link", { name: "Routines" })).not.toHaveAttribute(
			"aria-current",
		);
	},
});

/** Starting a thread with a bot marks the bot as the open row. */
export const StartingWithABotWithNoThreads = meta.story({
	args: {
		rows: revenueRows.slice(0, 2),
		selected: { kind: "bot", handle: leadResearcher.handle },
	},
	play: async ({ canvas }) => {
		await expect(canvas.getByRole("button", { name: leadResearcher.name })).toHaveAttribute(
			"aria-current",
			"page",
		);
	},
});

/** A shared pod's chats sit above its bots, counting what is new in them with a dot. */
export const PodChat = meta.story({
	args: { selected: { kind: "podChat" } },
	play: async ({ canvas }) => {
		const chat = canvas.getByRole("link", { name: /^General/ });
		await expect(chat).toHaveAttribute("aria-current", "page");
		await expect(chat).toHaveTextContent("2 unread messages");
	},
});

/** A pod whose chat nobody has opened yet still offers it, and opens it from its own address. */
export const PodChatUnopened = meta.story({
	args: { chats: { list: [], onNew: fn() } },
	play: async ({ canvas }) => {
		await expect(canvas.getByRole("link", { name: /^General/ })).toHaveAttribute(
			"href",
			expect.stringMatching(/\/pods\/revenue\/chat$/),
		);
	},
});

const newChat = fn();

/** A pod with more than one chat lists them under Chats, with + to start another; the one open is marked. */
export const SeveralChats = meta.story({
	args: {
		chats: { list: [revenueChat, pricingChat], onNew: newChat },
		selected: { kind: "conversation", conversationId: pricingChat.conversation.id },
	},
	play: async ({ canvas, userEvent }) => {
		await expect(canvas.getByRole("link", { name: /^Pricing/ })).toHaveAttribute(
			"aria-current",
			"page",
		);
		await userEvent.click(canvas.getByRole("button", { name: `New channel in ${revenue.name}` }));
		await expect(newChat).toHaveBeenCalledOnce();
	},
});

const peopleThread: ChatListItem = {
	agent: null,
	conversation: {
		...storyConversationFor(growthDesk),
		id: "0199a3a0-0000-7000-8000-00000000c950",
		hostAgentId: null,
		startedInChatId: revenueChat.conversation.id,
		title: "Who's covering Halcyon next week?",
	},
	unreadMessages: 2,
	needsApproval: false,
	mentionsYou: false,
	lastMessage: null,
	waitingOn: null,
};

/** A thread between people hangs under the chat it was started from, counting what is unread in it. */
export const PeopleThread = meta.story({
	args: { rows: [peopleThread, ...revenueRows], selected: undefined },
	play: async ({ canvas }) => {
		const thread = canvas.getByRole("link", { name: /Who's covering Halcyon next week\?/ });
		await expect(thread).toHaveTextContent("2 unread messages");
		await expect(thread.closest("li")?.parentElement?.closest("li")).toHaveTextContent(/^General/);
		await expect(canvas.queryByRole("button", { name: "People" })).toBeNull();
	},
});

/** A thread between people not started from one of the chats listed sits under People, after the bots. */
export const PeopleThreadWithoutAChat = meta.story({
	args: {
		rows: [
			{ ...peopleThread, conversation: { ...peopleThread.conversation, startedInChatId: null } },
			...revenueRows,
		],
		selected: { kind: "conversation", conversationId: peopleThread.conversation.id },
	},
	play: async ({ canvas }) => {
		await expect(canvas.getByRole("button", { name: "People" })).toHaveAttribute(
			"aria-expanded",
			"true",
		);
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

const doneThreads: ChatListItem[] = ["Renewal deck", "Halcyon intro"].map((title, index) => ({
	...(revenueRows[1] as ChatListItem),
	conversation: {
		...(revenueRows[1] as ChatListItem).conversation,
		id: `0199a3a0-0000-7000-8000-00000000e${String(index).padStart(3, "0")}`,
		title,
		doneAt: "2026-09-18T07:00:00.000Z",
	},
	unreadMessages: 0,
}));

/**
 * An open bot shows its first four threads, and the open one wherever it is,
 * then how many more there are. Done threads are not listed.
 */
export const ShowMore = meta.story({
	args: {
		selected: {
			kind: "conversation",
			conversationId: (accountManagerThreads[5] as ChatListItem).conversation.id,
		},
		rows: [...accountManagerThreads, ...doneThreads],
	},
	play: async ({ canvas, userEvent }) => {
		await expect(canvas.getByRole("link", { name: /Churn interviews summary/ })).toBeVisible();
		await expect(canvas.queryByRole("link", { name: /Onboarding email audit/ })).toBeNull();
		await expect(canvas.getByRole("link", { name: /Pricing page teardown/ })).toBeVisible();
		await userEvent.click(canvas.getByRole("button", { name: "Show 1 more" }));
		await expect(canvas.getByRole("link", { name: /Onboarding email audit/ })).toBeVisible();
		await expect(canvas.queryByRole("link", { name: /Renewal deck/ })).toBeNull();
	},
});

/** A thread just marked done stays listed, ticked, while it is the one open. */
export const OpenDoneThread = meta.story({
	args: {
		selected: {
			kind: "conversation",
			conversationId: (doneThreads[0] as ChatListItem).conversation.id,
		},
		rows: [...accountManagerThreads.slice(0, 2), ...doneThreads],
	},
	play: async ({ canvas }) => {
		await expect(canvas.getByRole("link", { name: /Renewal deck/ })).toHaveAttribute(
			"aria-current",
			"page",
		);
		await expect(canvas.queryByRole("link", { name: /Halcyon intro/ })).toBeNull();
	},
});

/** A Personal pod has no chats, and each conversation goes by its bot's name. */
export const PersonalPod = meta.story({
	args: {
		pod: personal,
		chats: undefined,
		bots: [chief],
		rows: [
			{
				agent: chief,
				conversation: storyConversationFor(chief),
				unreadMessages: 0,
				needsApproval: false,
				mentionsYou: false,
				lastMessage: null,
				waitingOn: null,
			},
		],
		selected: { kind: "conversation", conversationId: storyConversationFor(chief).id },
	},
	play: async ({ canvas }) => {
		await expect(canvas.queryByRole("heading", { name: "Channels" })).toBeNull();
		await expect(canvas.getByRole("link", { name: "Chief" })).toHaveAttribute(
			"aria-current",
			"page",
		);
	},
});

const newBot = fn();

/** A pod with no bots offers the first under Bots, as an Add a bot row with a dashed face. */
export const EmptyPod = meta.story({
	args: {
		pod: design,
		chats: undefined,
		bots: [],
		rows: [],
		selected: undefined,
		onNewBot: newBot,
	},
	play: async ({ canvas, userEvent }) => {
		await userEvent.click(canvas.getByRole("button", { name: "Add a bot" }));
		await expect(newBot).toHaveBeenCalled();
	},
});

/** A pod somebody may not add a bot to says it has none, in the same row, with nothing to press. */
export const EmptyPodForAMember = meta.story({
	args: {
		pod: design,
		chats: undefined,
		bots: [],
		rows: [],
		selected: undefined,
		onNewBot: undefined,
	},
	play: async ({ canvas }) => {
		await expect(canvas.getByText("No bots yet")).toBeVisible();
		await expect(canvas.queryByRole("button", { name: "Add a bot" })).toBeNull();
	},
});

/** Failed says the chats could not be loaded. */
export const Failed = meta.story({ args: { rows: [], status: "failed" as const } });
