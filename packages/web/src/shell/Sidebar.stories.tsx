import { QueryClientProvider } from "@tanstack/react-query";
import { useState } from "react";
import { expect, fn } from "storybook/test";
import preview from "#storybook/preview";
import { createQueryClient } from "@/lib/query.ts";
import { storyPodChatFor } from "@/story-app.tsx";
import { ChannelConversationsView } from "./ConversationList.tsx";
import { DirectMessagesSection } from "./DirectMessages.tsx";
import { SidebarView } from "./Sidebar.tsx";
import {
	accountManager,
	chief,
	design,
	engineering,
	growthDesk,
	linearHandler,
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

const nothing = { unreadMessages: 0, needsApproval: false, failedRoutines: 0 };

const meta = preview.meta({
	title: "Product/Sidebar",
	component: SidebarView,
	tags: ["ai-generated"],
	parameters: { layout: "fullscreen" },
	beforeEach: () => {
		// Every channel but Revenue starts folded, as somebody working in Revenue keeps them.
		localStorage.setItem("sugabots-folded", JSON.stringify([engineering.id, design.id]));
		return () => localStorage.removeItem("sugabots-folded");
	},
	args: {
		assistant: { agent: chief, ...nothing },
		channels: [
			{ pod: revenue, ...nothing },
			{ pod: engineering, ...nothing, unreadMessages: 4 },
			{ pod: design, ...nothing, needsApproval: true },
		],
		bots: [
			{ agent: growthDesk, ...nothing },
			{ agent: accountManager, ...nothing, unreadMessages: 2 },
			{ agent: linearHandler, ...nothing, failedRoutines: 1 },
		],
		currentPodSlug: revenue.slug,
		view: undefined,
		unreadForYou: 1,
		unreadInInbox: 3,
		waitingApprovals: 2,
		workspace: suga,
		workspaces: [suga],
		user: { name: "Rowan Ellis", email: "rowan@example.com" },
		onSignOut: fn(),
		onNewBot: fn(),
		directMessages: (
			<DirectMessagesSection items={[withPriya, withPriyaAndTheo, withMarco]} status="ready" />
		),
		conversationsOf: (pod) => (
			<ChannelConversationsView
				pod={pod}
				chats={[{ conversation: storyPodChatFor(pod), unreadMessages: 0 }]}
				status="ready"
			/>
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

/**
 * Default: the Personal Assistant at the top, Inbox and Approvals, the
 * channels with Revenue open on its main chat, and the pinned bots.
 */
export const Default = meta.story({
	play: async ({ canvas }) => {
		await expect(canvas.getByRole("link", { name: chief.name })).toBeVisible();
		await expect(canvas.getByRole("region", { name: "Channels" })).toBeVisible();
		await expect(canvas.getByRole("link", { name: growthDesk.name })).toBeVisible();
	},
});

/** Inbox open, shaded in the sidebar. */
export const InboxOpen = meta.story({
	args: { view: "inbox", currentPodSlug: undefined },
});
