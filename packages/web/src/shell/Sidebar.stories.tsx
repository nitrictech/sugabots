import { QueryClientProvider } from "@tanstack/react-query";
import { useState } from "react";
import { expect, fn, within } from "storybook/test";
import preview from "#storybook/preview";
import { createQueryClient } from "@/lib/query.ts";
import { SessionContext } from "@/lib/session.ts";
import { appHandlers, storyMember } from "@/story-app.test-support.tsx";
import { IconRail } from "./IconRail.tsx";
import { OwnerSidebar } from "./OwnerSidebar.tsx";
import { SidebarView } from "./Sidebar.tsx";
import {
	accountManager,
	chief,
	deputy,
	design,
	engineering,
	growthDesk,
	linearHandler,
	revenue,
} from "./story-fixtures.test-support.ts";

const suga = {
	id: "0199a3a0-0000-7000-8000-000000000001",
	name: "Suga",
	slug: "suga",
	timeZone: "UTC",
	setUpAt: "2026-09-01T00:00:00.000Z",
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
		assistants: [{ bot: chief, ...nothing }],
		projects: projectStandings,
		bots: [
			{ bot: growthDesk, ...nothing },
			{ bot: accountManager, ...nothing, unreadMessages: 2 },
			{ bot: linearHandler, ...nothing, failedAutomations: 1 },
		],
		view: undefined,
		workspace: suga,
		workspaces: [suga],
		signedIn: { name: "Rowan Ellis", email: "rowan@example.com" },
		onSignOut: fn(),
		onNewBot: fn(),
		onNewProject: fn(),
	},
	decorators: [
		(Story) => (
			<div className="flex h-screen">
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
 * Default: the workspace's sidebar, as on Approvals or a page of the workspace's
 * own: the Personal Assistant first, then the projects and the bots, and Settings
 * in the foot. Opening a project narrows it to the rail; see Owner open.
 */
export const Default = meta.story({
	play: async ({ canvas }) => {
		await expect(canvas.getByRole("link", { name: chief.name })).toBeVisible();
		await expect(canvas.getByRole("group", { name: "Projects" })).toBeVisible();
		await expect(canvas.getByRole("link", { name: growthDesk.name })).toBeVisible();
		await expect(canvas.getByRole("link", { name: "Settings" })).toBeVisible();
	},
});

/**
 * Settings open: over whichever page they were opened on, which keeps its
 * sidebar, with Settings in the foot shaded while they are.
 */
export const SettingsOpen = meta.story({
	args: { view: "settings" },
	play: async ({ canvas }) => {
		await expect(canvas.getByRole("link", { name: "Settings" })).toHaveAttribute(
			"aria-current",
			"page",
		);
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
	// Revenue's chats mark the ones that need you, so they ask who you are.
	decorators: [
		(Story) => (
			<SessionContext value={{ member: storyMember, error: undefined, refresh: async () => {} }}>
				<Story />
			</SessionContext>
		),
	],
	args: {
		rail: (
			<IconRail
				assistants={[{ bot: chief, ...nothing }]}
				projects={projectStandings}
				bots={[{ bot: growthDesk, ...nothing }]}
				currentProjectSlug={revenue.slug}
				currentBotHandle={undefined}
			/>
		),
		focus: (
			<OwnerSidebar owner={{ project: revenue }} selectedChatId={undefined} page={undefined} />
		),
	},
	play: async ({ canvas }) => {
		const rail = canvas.getByRole("navigation", { name: "Projects and bots" });
		await expect(within(rail).getByRole("link", { name: revenue.name })).toHaveAttribute(
			"aria-current",
			"page",
		);
		await expect(canvas.getByRole("navigation", { name: `${revenue.name}'s pages` })).toBeVisible();
		await expect(canvas.queryByRole("group", { name: "Projects" })).toBeNull();
	},
});

/**
 * Several Personal Assistants: a member who made more than the one they were
 * given has every one of them at the top, oldest first, above the projects,
 * and the workspace's home opens on the oldest.
 */
export const SeveralAssistants = meta.story({
	args: {
		assistants: [
			{ bot: chief, ...nothing },
			{ bot: deputy, ...nothing, unreadMessages: 1 },
		],
		assistantOpen: true,
	},
	play: async ({ canvas }) => {
		const sidebar = canvas.getByRole("navigation", { name: "Sidebar" });
		const links = within(sidebar).getAllByRole("link");
		await expect(links[0]).toHaveAccessibleName(chief.name);
		await expect(links[0]).toHaveAttribute("aria-current", "page");
		await expect(links[1]).toHaveAccessibleName(new RegExp(`^${deputy.name}`));
		await expect(links[1]).not.toHaveAttribute("aria-current");
	},
});
