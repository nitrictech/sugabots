import { QueryClientProvider } from "@tanstack/react-query";
import { useState } from "react";
import { expect, fn } from "storybook/test";
import preview from "#storybook/preview";
import { createQueryClient } from "@/lib/query.ts";
import { storyChannelConversationFor } from "@/story-app.tsx";
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

const nothing = { unreadMessages: 0, needsApproval: false, failedAutomations: 0 };

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
		assistant: { bot: chief, ...nothing },
		channels: [
			{ channel: revenue, ...nothing },
			{ channel: engineering, ...nothing, unreadMessages: 4 },
			{ channel: design, ...nothing, needsApproval: true },
		],
		bots: [
			{ bot: growthDesk, ...nothing },
			{ bot: accountManager, ...nothing, unreadMessages: 2 },
			{ bot: linearHandler, ...nothing, failedAutomations: 1 },
		],
		currentChannelSlug: revenue.slug,
		view: undefined,
		workspace: suga,
		workspaces: [suga],
		user: { name: "Rowan Ellis", email: "rowan@example.com" },
		onSignOut: fn(),
		onNewBot: fn(),
		directMessages: (
			<DirectMessagesSection items={[withPriya, withPriyaAndTheo, withMarco]} status="ready" />
		),
		conversationsOf: (channel) => (
			<ChannelConversationsView
				channel={channel}
				chats={[{ conversation: storyChannelConversationFor(channel), unreadMessages: 0 }]}
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
 * Default: the channels with Revenue open on its main chat, then the bots,
 * the Personal Assistant first, and Settings in the foot.
 */
export const Default = meta.story({
	play: async ({ canvas }) => {
		await expect(canvas.getByRole("link", { name: chief.name })).toBeVisible();
		await expect(canvas.getByRole("region", { name: "Channels" })).toBeVisible();
		await expect(canvas.getByRole("link", { name: growthDesk.name })).toBeVisible();
		await expect(canvas.getByRole("link", { name: "Settings" })).toBeVisible();
	},
});
