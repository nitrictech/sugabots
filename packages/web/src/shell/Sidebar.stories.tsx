import type { ChatListItem } from "@sugabots/contracts";
import { QueryClientProvider } from "@tanstack/react-query";
import { HttpResponse, http } from "msw";
import { useState } from "react";
import { expect, fn, screen, waitFor, within } from "storybook/test";
import preview from "#storybook/preview";
import { createQueryClient } from "@/lib/query.ts";
import { storyChannelFor, storyConversationFor, storyPodChatFor } from "@/story-app.tsx";
import { ConversationListView } from "./ConversationList.tsx";
import { DirectMessagesSection } from "./DirectMessages.tsx";
import { SidebarView } from "./Sidebar.tsx";
import {
	accountManager,
	design,
	engineering,
	growthDesk,
	leadResearcher,
	personal,
	revenue,
	withMarco,
	withPriya,
	withPriyaAndTheo,
} from "./story-fixtures.ts";

const suga = {
	id: "0199a3a0-0000-7000-8000-000000000001",
	name: "Suga",
	slug: "suga",
	timeZone: "UTC",
	setupCompletedAt: "2026-09-01T00:00:00.000Z",
};
const nitric = {
	id: "0199a3a0-0000-7000-8000-000000000002",
	name: "Nitric",
	slug: "nitric",
	timeZone: "UTC",
	setupCompletedAt: "2026-09-01T00:00:00.000Z",
};

const threads: ChatListItem[] = [growthDesk, accountManager, leadResearcher].map(
	(agent, index) => ({
		agent,
		conversation: storyConversationFor(agent),
		unreadMessages: index === 1 ? 3 : 0,
		needsApproval: false,
		mentionsYou: false,
		lastMessage: null,
		participants: [],
		waitingOn: null,
	}),
);

const revenueList = (
	<ConversationListView
		pod={revenue}
		chats={[{ conversation: storyPodChatFor(revenue), unreadMessages: 0 }]}
		bots={[accountManager, growthDesk, leadResearcher]}
		rows={threads}
		status="ready"
		selected={{ kind: "conversation", conversationId: storyConversationFor(growthDesk).id }}
		onNewBot={fn()}
	/>
);

const meta = preview.meta({
	title: "Product/Sidebar",
	component: SidebarView,
	tags: ["ai-generated"],
	parameters: { layout: "fullscreen" },
	beforeEach: () => {
		localStorage.removeItem(`sugabots-open-bots:${revenue.id}`);
		// Every pod but Revenue starts folded, as somebody working in Revenue keeps them.
		localStorage.setItem(
			"sugabots-folded",
			JSON.stringify([engineering.id, design.id, personal.id]),
		);
		return () => localStorage.removeItem("sugabots-folded");
	},
	args: {
		pods: [
			{ pod: revenue, unreadMessages: 0, needsApproval: false, failedRoutines: 0 },
			{ pod: engineering, unreadMessages: 4, needsApproval: false, failedRoutines: 1 },
			{ pod: design, unreadMessages: 0, needsApproval: true, failedRoutines: 0 },
			{ pod: personal, unreadMessages: 0, needsApproval: false, failedRoutines: 0 },
		],
		currentPodId: revenue.id,
		view: undefined,
		unreadForYou: 1,
		unreadInInbox: 3,
		waitingApprovals: 2,
		workspace: suga,
		workspaces: [suga, nitric],
		user: { name: "Rowan Ellis", email: "rowan@example.com" },
		onSignOut: fn(),
		directMessages: (
			<DirectMessagesSection items={[withPriya, withPriyaAndTheo, withMarco]} status="ready" />
		),
		conversationsOf: (pod) =>
			pod.id === revenue.id ? (
				revenueList
			) : (
				<ConversationListView pod={pod} bots={[]} rows={[]} status="ready" />
			),
	},
	decorators: [
		(Story) => (
			<div className="flex h-180">
				<Story />
			</div>
		),
		// The Help menu asks the API for the running version.
		function Queries(Story) {
			const [queryClient] = useState(createQueryClient);
			return (
				<QueryClientProvider client={queryClient}>
					<Story />
				</QueryClientProvider>
			);
		},
	],
});

const API = import.meta.env.VITE_API_URL as string;

/**
 * Default is a pod open on one of its threads: Inbox counting its unread
 * mentions and Approvals what waits on you, the pod by name, and its chats
 * and bots.
 */
export const Default = meta.story({
	play: async ({ canvas }) => {
		await expect(canvas.getByRole("link", { name: /^Inbox/ })).toHaveTextContent(
			"1 unread message for you",
		);
		await expect(canvas.getByRole("link", { name: /^Approvals/ })).toHaveTextContent(
			"2 waiting on you",
		);
		await expect(canvas.getByRole("link", { name: "Settings" })).toHaveAttribute(
			"href",
			"/suga/settings",
		);
		await expect(canvas.getByRole("link", { name: "Artifacts" })).toHaveAttribute(
			"href",
			expect.stringMatching(/\/pods\/revenue\/artifacts$/),
		);
	},
});

/** Inbox open, with nothing new in it or waiting: neither counts anything. */
export const InboxOpen = meta.story({
	args: { view: "inbox", unreadForYou: 0, unreadInInbox: 0, waitingApprovals: 0 },
	play: async ({ canvas }) => {
		await expect(canvas.getByRole("link", { name: "Inbox" })).toHaveAttribute(
			"aria-current",
			"page",
		);
		await expect(canvas.getByRole("link", { name: "Approvals" })).not.toHaveAttribute(
			"aria-current",
		);
	},
});

/**
 * Inbox with things unread but none mentioning you, such as routine runs: a
 * dot where the count would be, since nothing in it needs you.
 */
export const InboxUnreadWithoutMentions = meta.story({
	args: { unreadForYou: 0, unreadInInbox: 3 },
	play: async ({ canvas }) => {
		const inbox = canvas.getByRole("link", { name: /^Inbox/ });
		await expect(inbox).toHaveTextContent("3 unread items");
		await expect(inbox).not.toHaveTextContent(/\d+ unread messages? for you/);
	},
});

/**
 * Every pod, one after another, shared first then Personal. A folded pod
 * counts what is new in it, or shows a dot for one waiting on you; folding
 * the open one hides its chats, and unfolding another shows its own. Under
 * the pointer a pod offers its settings.
 */
export const Pods = meta.story({
	play: async ({ canvas, userEvent }) => {
		await expect(canvas.getAllByRole("group").map((pod) => pod.getAttribute("aria-label"))).toEqual(
			["Revenue", "Engineering", "Design", "Personal"],
		);
		const engineeringFold = canvas.getByRole("button", { name: /^Engineering/ });
		await expect(engineeringFold).toHaveAttribute("aria-expanded", "false");
		await expect(canvas.getByRole("group", { name: "Engineering" })).toHaveTextContent(
			"4 unread messages, 1 failed routine",
		);
		await expect(canvas.getByRole("group", { name: "Design" })).toHaveTextContent(
			"Waiting for your approval",
		);

		const revenueFold = canvas.getByRole("button", { name: "Revenue" });
		await userEvent.click(revenueFold);
		await expect(revenueFold).toHaveAttribute("aria-expanded", "false");
		await expect(canvas.queryByRole("link", { name: "Growth Desk" })).toBeNull();

		await userEvent.click(engineeringFold);
		const engineeringPod = canvas.getByRole("group", { name: "Engineering" });
		await userEvent.hover(engineeringFold);
		await expect(
			within(engineeringPod).getByRole("link", { name: "Engineering settings" }),
		).toHaveAttribute("href", expect.stringMatching(/\/settings\/pods\/engineering$/));
		await expect(within(engineeringPod).getByRole("link", { name: "Artifacts" })).toHaveAttribute(
			"href",
			expect.stringMatching(/\/pods\/engineering\/artifacts$/),
		);
	},
});

/** A pod lists its channels and then its bots in one list, with no sections to fold. */
export const ChannelsThenBots = meta.story({
	play: async ({ canvas }) => {
		await expect(canvas.queryByRole("button", { name: "Bots" })).toBeNull();
		await expect(canvas.queryByRole("button", { name: "Channels" })).toBeNull();
		const revenuePod = canvas.getByRole("group", { name: "Revenue" });
		const names = within(revenuePod)
			.getAllByRole("link")
			.map((link) => link.textContent);
		await expect(names.indexOf("General")).toBeLessThan(names.indexOf(accountManager.name));
	},
});

/**
 * Personal open: each of its bots opens its channel with you, and shows its
 * threads under it while it is open, as a shared pod's do, bold
 * while something there is new. Its name says only you see into it, and
 * with the pointer over that, that admins don't either.
 */
export const PersonalPod = meta.story({
	args: {
		currentPodId: personal.id,
		conversationsOf: (pod) => (
			<ConversationListView
				pod={pod}
				bots={pod.id === personal.id ? [growthDesk, leadResearcher] : []}
				rows={
					pod.id === personal.id
						? threads
								.filter((row) => row.agent?.id !== accountManager.id)
								.map((row) => ({ ...row, unreadMessages: row.agent?.id === growthDesk.id ? 2 : 0 }))
						: []
				}
				channels={
					pod.id === personal.id
						? [growthDesk, leadResearcher].map((agent) => ({
								agent,
								conversation: storyChannelFor(agent),
								unreadMessages: 0,
								needsApproval: false,
								mentionsYou: false,
							}))
						: []
				}
				status="ready"
				selected={{ kind: "conversation", conversationId: storyChannelFor(leadResearcher).id }}
			/>
		),
	},
	beforeEach: () => {
		localStorage.setItem(
			"sugabots-folded",
			JSON.stringify([revenue.id, engineering.id, design.id]),
		);
		return () => localStorage.removeItem("sugabots-folded");
	},
	play: async ({ canvas, userEvent }) => {
		const personalPod = canvas.getByRole("group", { name: "Personal" });
		await expect(within(personalPod).getByRole("link", { name: growthDesk.name })).toBeVisible();
		// The bot's row comes first, before its conversation, which goes by its name too.
		const [channel] = within(personalPod).getAllByRole("link", { name: leadResearcher.name });
		await expect(channel).toHaveAttribute("aria-current", "page");

		const toggle = within(personalPod).getByRole("button", { name: "Personal Only you" });
		await expect(toggle).toHaveAccessibleDescription(
			"Only you can see into this pod. Nobody else can, workspace admins included.",
		);
		await userEvent.hover(within(toggle).getByText("Only you"));
		await expect(
			await screen.findByText("Nobody else can, workspace admins included."),
		).toBeVisible();
	},
});

/**
 * Routines are reached from the bot's own page, not the sidebar, so a bot
 * whose routine failed its latest run shows a red dot at its row's end.
 */
export const BotWithAFailedRoutine = meta.story({
	beforeEach: () => {
		localStorage.setItem(
			"sugabots-folded",
			JSON.stringify([engineering.id, design.id, personal.id]),
		);
		return () => localStorage.removeItem("sugabots-folded");
	},
	args: {
		conversationsOf: (pod) =>
			pod.id === revenue.id ? (
				<ConversationListView
					pod={revenue}
					bots={[accountManager, growthDesk, leadResearcher]}
					rows={threads}
					routines={[
						{
							routine: {
								id: "0199a3a0-0000-7000-8000-0000000003b1",
								name: "Overnight outbound",
								state: "enabled",
								failed: true,
								pausedAfterFailures: false,
							},
							agent: growthDesk,
							conversation: null,
							mentionsYou: false,
						},
					]}
					status="ready"
					selected={{ kind: "bot", handle: growthDesk.handle }}
				/>
			) : (
				<ConversationListView pod={pod} bots={[]} rows={[]} status="ready" />
			),
	},
	play: async ({ canvas }) => {
		const revenuePod = canvas.getByRole("group", { name: "Revenue" });
		await expect(within(revenuePod).queryByRole("link", { name: /^Routines/ })).toBeNull();
		const [desk] = within(revenuePod).getAllByRole("link", { name: growthDesk.name });
		await expect(desk?.closest("li")).toHaveTextContent("Latest run failed");
	},
});

/**
 * Your menu names you, leads to your preferences and signs you out. Its
 * workspace item opens the workspace's own menu, with the others to switch to.
 */
export const AccountMenu = meta.story({
	play: async ({ canvas, userEvent, args }) => {
		await userEvent.click(canvas.getByRole("button", { name: "Account: Rowan Ellis" }));
		const menu = await screen.findByRole("menu");
		await expect(within(menu).getByText("rowan@example.com")).toBeVisible();
		await expect(within(menu).getByRole("menuitem", { name: "Preferences" })).toHaveAttribute(
			"href",
			"/suga/settings/profile",
		);

		await userEvent.click(within(menu).getByRole("menuitem", { name: "Suga" }));
		await waitFor(() => expect(screen.getAllByRole("menu")).toHaveLength(2));
		const workspaceMenu = screen.getAllByRole("menu").at(-1) as HTMLElement;
		await expect(
			within(workspaceMenu).getByRole("menuitem", { name: "Invite people" }),
		).toHaveAttribute("href", "/suga/settings/members");
		await expect(
			within(workspaceMenu).queryByRole("menuitem", { name: "Workspace settings" }),
		).toBeNull();
		await expect(within(workspaceMenu).getByRole("menuitem", { name: "Nitric" })).toHaveAttribute(
			"href",
			"/nitric/agents",
		);
		await expect(
			within(workspaceMenu).getByRole("menuitem", { name: "New workspace" }),
		).toHaveAttribute("href", "/onboarding");

		await userEvent.keyboard("{Escape}");
		await userEvent.click(within(menu).getByRole("menuitem", { name: "Sign out" }));
		await expect(args.onSignOut).toHaveBeenCalledOnce();
	},
});

/**
 * The ? beside you: links out to the docs, Discord, a new bug report and the
 * release notes, each in a new tab, then About with the running version.
 */
export const HelpMenu = meta.story({
	beforeEach({ msw }) {
		msw.use(
			http.get(`${API}/health`, () =>
				HttpResponse.json({
					status: "ok",
					version: "0.2.0",
					commit: "338298a29e743a513c1108ae3829d39c80230781",
				}),
			),
		);
	},
	play: async ({ canvas, userEvent }) => {
		await userEvent.click(canvas.getByRole("button", { name: "Help" }));
		const menu = await screen.findByRole("menu");
		await expect(within(menu).getByRole("menuitem", { name: /^Documentation/ })).toHaveAttribute(
			"target",
			"_blank",
		);
		await expect(
			await within(menu).findByRole("menuitem", { name: "About Sugabots 0.2.0" }),
		).toBeVisible();
	},
});
