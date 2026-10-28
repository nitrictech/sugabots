import type { ChatListItem } from "@sugabots/contracts";
import { QueryClientProvider } from "@tanstack/react-query";
import { HttpResponse, http } from "msw";
import { useState } from "react";
import { expect, fn, screen, waitFor, within } from "storybook/test";
import preview from "#storybook/preview";
import { createQueryClient } from "@/lib/query.ts";
import { storyConversationFor, storyPodChatFor } from "@/story-app.tsx";
import { ConversationListView } from "./ConversationList.tsx";
import { SidebarView } from "./Sidebar.tsx";
import {
	accountManager,
	design,
	engineering,
	growthDesk,
	leadResearcher,
	personal,
	revenue,
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
		waitingOn: null,
	}),
);

const revenueList = (
	<ConversationListView
		pod={revenue}
		chats={{
			list: [{ conversation: storyPodChatFor(revenue), unreadMessages: 0 }],
			onNew: fn(),
		}}
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
		unreadInInbox: 3,
		waitingApprovals: 2,
		workspace: suga,
		workspaces: [suga, nitric],
		user: { name: "Ryan Eyes", email: "ryan@example.com" },
		onSignOut: fn(),
		conversationsOf: (pod) =>
			pod.id === revenue.id ? (
				revenueList
			) : (
				<ConversationListView pod={pod} bots={[]} rows={[]} status="ready" />
			),
	},
	decorators: [
		(Story) => (
			<div className="flex h-[720px]">
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
 * Default is a pod open on one of its threads: Inbox counting what is unread
 * and Approvals what waits on you, the pod by name, and its chats and bots.
 */
export const Default = meta.story({
	play: async ({ canvas }) => {
		await expect(canvas.getByRole("link", { name: /^Inbox/ })).toHaveTextContent("3 unread");
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
	args: { view: "inbox", unreadInInbox: 0, waitingApprovals: 0 },
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

/**
 * A pod's Channels and Bots fold away under their names, like a pod. Folded,
 * Bots counts what is unread in its threads.
 */
export const FoldingSections = meta.story({
	play: async ({ canvas, userEvent }) => {
		const bots = canvas.getByRole("button", { name: "Bots" });
		await userEvent.click(bots);
		await expect(bots).toHaveAttribute("aria-expanded", "false");
		await expect(canvas.queryByRole("button", { name: "Account Manager" })).toBeNull();
		await expect(canvas.getByRole("heading", { name: /^Bots/ })).toHaveTextContent(
			"3 unread messages",
		);

		const chats = canvas.getByRole("button", { name: "Channels" });
		await userEvent.click(chats);
		await expect(canvas.queryByRole("link", { name: "General" })).toBeNull();
		await userEvent.click(chats);
		await expect(canvas.getByRole("link", { name: "General" })).toBeVisible();
	},
});

/**
 * Personal open: each of its bots folds open, as a shared pod's do, on its
 * Routines and the one conversation it keeps with you, bold while something
 * there is new.
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
				status="ready"
				selected={{ kind: "conversation", conversationId: storyConversationFor(leadResearcher).id }}
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
	play: async ({ canvas }) => {
		const personalPod = canvas.getByRole("group", { name: "Personal" });
		await expect(within(personalPod).getByRole("button", { name: /^Growth Desk/ })).toBeVisible();
		await expect(within(personalPod).getByRole("link", { name: /^Routines/ })).toBeVisible();
		await expect(
			within(personalPod).getByRole("link", { name: /^Lead Researcher/ }),
		).toHaveAttribute("aria-current", "page");
	},
});

/**
 * Every bot has Routines as its first row, whether it runs any yet or not,
 * which opens its Routines page, with a red dot while one failed its latest run.
 */
export const BotRoutines = meta.story({
	beforeEach: () => {
		localStorage.setItem(
			`sugabots-open-bots:${revenue.id}`,
			JSON.stringify([growthDesk.id, accountManager.id]),
		);
		localStorage.setItem(
			"sugabots-folded",
			JSON.stringify([engineering.id, design.id, personal.id]),
		);
		return () => {
			localStorage.removeItem(`sugabots-open-bots:${revenue.id}`);
			localStorage.removeItem("sugabots-folded");
		};
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
							},
							agent: growthDesk,
							conversation: null,
							mentionsYou: false,
						},
					]}
					status="ready"
					selected={undefined}
				/>
			) : (
				<ConversationListView pod={pod} bots={[]} rows={[]} status="ready" />
			),
	},
	play: async ({ canvas }) => {
		const revenuePod = canvas.getByRole("group", { name: "Revenue" });
		const routines = within(revenuePod).getAllByRole("link", { name: /^Routines/ });
		await expect(routines).toHaveLength(2);
		const [manager, desk] = routines;
		await expect(manager).toHaveAttribute(
			"href",
			expect.stringMatching(new RegExp(`routines\\?bot=${accountManager.handle}$`)),
		);
		await expect(manager).not.toHaveTextContent("Latest run failed");
		await expect(desk).toHaveTextContent("Latest run failed");
	},
});

/**
 * Your menu names you, leads to your preferences and signs you out. Its
 * workspace item opens the workspace's own menu, with the others to switch to.
 */
export const AccountMenu = meta.story({
	play: async ({ canvas, userEvent, args }) => {
		await userEvent.click(canvas.getByRole("button", { name: "Account: Ryan Eyes" }));
		const menu = await screen.findByRole("menu");
		await expect(within(menu).getByText("ryan@example.com")).toBeVisible();
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

/** On a phone the sidebar is the page until something in it is opened. */
export const Phone = meta.story({
	globals: { viewport: { value: "mobile1" } },
});
