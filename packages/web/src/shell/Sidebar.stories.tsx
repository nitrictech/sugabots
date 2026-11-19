import { QueryClientProvider } from "@tanstack/react-query";
import { useState } from "react";
import { expect, fn, within } from "storybook/test";
import preview from "#storybook/preview";
import { createQueryClient } from "@/lib/query.ts";
import { appHandlers } from "@/story-app.tsx";
import { DirectMessagesSection } from "./DirectMessages.tsx";
import { IconRail } from "./IconRail.tsx";
import { OwnerSidebar } from "./OwnerSidebar.tsx";
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

const projectStandings = [
	{ project: revenue, ...nothing },
	{ project: engineering, ...nothing, unreadMessages: 4 },
	{ project: design, ...nothing, needsApproval: true },
];

const meta = preview.meta({
	title: "Product/Sidebar",
	component: SidebarView,
	tags: ["ai-generated"],
	parameters: { layout: "fullscreen" },
	args: {
		assistant: { bot: chief, ...nothing },
		projects: projectStandings,
		bots: [
			{ bot: growthDesk, ...nothing },
			{ bot: accountManager, ...nothing, unreadMessages: 2 },
			{ bot: linearHandler, ...nothing, failedAutomations: 1 },
		],
		currentProjectSlug: revenue.slug,
		view: undefined,
		workspace: suga,
		workspaces: [suga],
		user: { name: "Rowan Ellis", email: "rowan@example.com" },
		onSignOut: fn(),
		onNewBot: fn(),
		directMessages: (
			<DirectMessagesSection items={[withPriya, withPriyaAndTheo, withMarco]} status="ready" />
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
 * Default: the projects with Revenue open, then the bots,
 * the Personal Assistant first, and Settings in the foot.
 */
export const Default = meta.story({
	play: async ({ canvas }) => {
		await expect(canvas.getByRole("link", { name: chief.name })).toBeVisible();
		await expect(canvas.getByRole("region", { name: "Projects" })).toBeVisible();
		await expect(canvas.getByRole("link", { name: growthDesk.name })).toBeVisible();
		await expect(canvas.getByRole("link", { name: "Settings" })).toBeVisible();
	},
});

/**
 * Owner open: on Revenue's pages the workspace narrows to the rail, with
 * Revenue shaded, and beside it Revenue's own sidebar in place of the
 * projects and bots.
 */
export const OwnerOpen = meta.story({
	beforeEach({ msw }) {
		msw.use(...appHandlers());
	},
	args: {
		rail: (
			<IconRail
				projects={projectStandings}
				bots={[
					{ bot: chief, ...nothing },
					{ bot: growthDesk, ...nothing },
				]}
				currentProjectSlug={revenue.slug}
				currentBotHandle={undefined}
			/>
		),
		focus: (
			<OwnerSidebar
				owner={{ project: revenue }}
				selectedConversationId={undefined}
				page={undefined}
			/>
		),
	},
	play: async ({ canvas }) => {
		const rail = canvas.getByRole("navigation", { name: "Projects and bots" });
		await expect(within(rail).getByRole("link", { name: revenue.name })).toHaveAttribute(
			"aria-current",
			"page",
		);
		await expect(canvas.getByRole("navigation", { name: `${revenue.name}'s pages` })).toBeVisible();
		await expect(canvas.queryByRole("region", { name: "Projects" })).toBeNull();
	},
});
