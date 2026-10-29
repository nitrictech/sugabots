import type { ChatListItem } from "@sugabots/contracts";
import { expect, fn } from "storybook/test";
import preview from "#storybook/preview";
import { storyChannelFor, storyConversationFor, storyPodChatFor } from "@/story-app.tsx";
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
 * Default is a pod's chat, then its bots, each folded but for the one holding
 * the open thread, whose threads show.
 */
export const Default = meta.story({
	play: async ({ canvas }) => {
		await expect(
			canvas.getByRole("link", { name: /Conversation with Lead Researcher/ }),
		).toHaveAttribute("aria-current", "page");
		await expect(canvas.queryByRole("link", { name: /Conversation with Growth Desk/ })).toBeNull();
	},
});

/**
 * A folded bot with something new in it is brighter and counts what is
 * unread in its threads; one with nothing new shows nothing at its end.
 */
export const UnreadAndWaiting = meta.story({
	play: async ({ canvas }) => {
		await expect(
			canvas.getByRole("link", { name: growthDesk.name }).closest("li"),
		).toHaveTextContent("1 unread message, needs you");
		const quiet = canvas.getByRole("link", { name: leadResearcher.name }).closest("li");
		await expect(quiet).not.toHaveTextContent("unread");
		await expect(quiet).not.toHaveTextContent(/\d/);
	},
});

/** Open, each of a bot's threads counts its unread messages, and one waiting on you says so too. */
export const UnreadInTheOpenBotsThreads = meta.story({
	args: {
		selected: {
			kind: "conversation" as const,
			conversationId: storyConversationFor(growthDesk).id,
		},
	},
	play: async ({ canvas }) => {
		await expect(
			canvas.getByRole("link", { name: /Conversation with Growth Desk/ }),
		).toHaveTextContent("1 unread message, needs you");
	},
});

/**
 * A bot with no thread yet is listed all the same, and opened shows its
 * Routines, which it has before it runs any; its + starts a thread with it.
 */
export const BotWithNoThreads = meta.story({
	args: {
		rows: revenueRows.slice(0, 2),
		selected: { kind: "bot", handle: leadResearcher.handle },
	},
	play: async ({ canvas }) => {
		await expect(canvas.getByRole("link", { name: "Routines" })).toHaveAttribute(
			"href",
			expect.stringMatching(new RegExp(`/pods/revenue/routines\\?bot=${leadResearcher.handle}$`)),
		);
		await expect(
			canvas.getByRole("link", { name: `New thread with ${leadResearcher.name}` }),
		).toHaveAttribute("href", expect.stringMatching(/\/pods\/revenue\/threads\/new\?agent=/));
	},
});

/** Every bot is folded, and none marked, while something else is open. */
export const BotsWhileTheChatIsOpen = meta.story({
	args: { rows: revenueRows.slice(0, 2), selected: { kind: "podChat" } },
	play: async ({ canvas }) => {
		await expect(canvas.getByRole("link", { name: /^General/ })).toHaveAttribute(
			"aria-current",
			"page",
		);
		await expect(canvas.getByRole("link", { name: leadResearcher.name })).not.toHaveAttribute(
			"aria-current",
		);
		await expect(canvas.queryByRole("link", { name: "Routines" })).toBeNull();
	},
});

/** A bot's channel, while it is found by the bot's handle, marks the bot as the open row, open on its Routines. */
export const OpeningABotsChannel = meta.story({
	args: {
		rows: revenueRows.slice(0, 2),
		selected: { kind: "bot", handle: leadResearcher.handle },
	},
	play: async ({ canvas }) => {
		await expect(canvas.getByRole("link", { name: leadResearcher.name })).toHaveAttribute(
			"aria-current",
			"page",
		);
		await expect(canvas.getByRole("link", { name: "Routines" })).toBeVisible();
	},
});

/** Starting a thread with a bot opens it on its Routines and threads, without marking its channel. */
export const StartingAThreadWithABot = meta.story({
	args: {
		rows: revenueRows.slice(0, 2),
		selected: { kind: "newThread", handle: leadResearcher.handle },
	},
	play: async ({ canvas }) => {
		await expect(canvas.getByRole("link", { name: "Routines" })).toBeVisible();
		await expect(canvas.getByRole("link", { name: leadResearcher.name })).not.toHaveAttribute(
			"aria-current",
		);
	},
});

const leadResearcherChannel = {
	agent: leadResearcher,
	conversation: storyChannelFor(leadResearcher),
	unreadMessages: 2,
	needsApproval: false,
	mentionsYou: false,
};

/**
 * A bot's name opens its channel, and stays bright with what is unread there
 * whether its threads are folded or not.
 */
export const ChannelUnread = meta.story({
	args: { channels: [leadResearcherChannel] },
	play: async ({ canvas }) => {
		const channel = canvas.getByRole("link", { name: leadResearcher.name });
		await expect(channel).toHaveAttribute(
			"href",
			expect.stringMatching(
				new RegExp(`/pods/revenue/threads/${leadResearcherChannel.conversation.id}$`),
			),
		);
		await expect(channel.closest("li")).toHaveTextContent("2 unread messages");
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

/**
 * A Personal pod has no pod channels. Each bot opens its own channel, with
 * its Routines under it.
 */
export const PersonalPod = meta.story({
	args: {
		pod: personal,
		chats: undefined,
		bots: [chief],
		rows: [],
		channels: [
			{
				agent: chief,
				conversation: storyChannelFor(chief),
				unreadMessages: 0,
				needsApproval: false,
				mentionsYou: false,
			},
		],
		selected: { kind: "conversation", conversationId: storyChannelFor(chief).id },
	},
	play: async ({ canvas }) => {
		await expect(canvas.queryByRole("heading", { name: "Channels" })).toBeNull();
		await expect(canvas.getByRole("link", { name: "Chief" })).toHaveAttribute(
			"aria-current",
			"page",
		);
		await expect(canvas.getByRole("link", { name: /^Routines/ })).toBeVisible();
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
