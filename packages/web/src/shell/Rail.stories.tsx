import { expect, fn, screen, waitFor } from "storybook/test";
import preview from "#storybook/preview";
import { RailView } from "./Rail.tsx";
import { podsWithBots } from "./story-fixtures.ts";

const suga = {
	id: "0199a3a0-0000-7000-8000-000000000001",
	name: "Suga",
	slug: "suga",
	timeZone: "UTC",
};
const nitric = {
	id: "0199a3a0-0000-7000-8000-000000000002",
	name: "Nitric",
	slug: "nitric",
	timeZone: "UTC",
};
const longName = {
	id: "0199a3a0-0000-7000-8000-000000000003",
	name: "The Extremely Thorough Research and Development Collective",
	slug: "research",
	timeZone: "UTC",
};

const meta = preview.meta({
	title: "Product/Rail",
	component: RailView,
	tags: ["ai-generated"],
	parameters: { layout: "fullscreen" },
	args: {
		pods: podsWithBots,
		selected: "revenue",
		user: { name: "Ryan Eyes" },
		onNewPod: fn(),
		onNewBot: fn(),
	},
	decorators: [
		(Story) => (
			<div className="flex h-[640px]">
				<Story />
			</div>
		),
	],
});

/** Default is a pod chosen: its bar on the left edge, All and the other pods beside it. */
export const Default = meta.story({
	play: async ({ canvas }) => {
		await expect(canvas.getByRole("link", { name: "Revenue" })).toHaveAttribute(
			"aria-current",
			"page",
		);
		await expect(canvas.getByRole("link", { name: "All" })).not.toHaveAttribute("aria-current");
	},
});

/**
 * Each pod with unread chats counts them on its tile, Personal included, past
 * 99 as 99+. A pod with a chat waiting on you shows a waving hand instead. All has
 * neither.
 */
export const UnreadCounts = meta.story({
	args: {
		pods: podsWithBots.map((entry, index) => ({
			...entry,
			unreadChats: [3, 2, 120, 1][index] ?? 0,
			needsApproval: index === 1,
		})),
	},
	play: async ({ canvas }) => {
		await expect(canvas.getByRole("link", { name: /, 3 unread chats$/ })).toBeVisible();
		await expect(canvas.getByText("99+")).toBeVisible();
		await expect(
			canvas.getByRole("link", { name: "Engineering, waiting for your approval" }),
		).toBeVisible();
		await expect(canvas.getByRole("link", { name: "All" })).toBeVisible();
	},
});

/** All is the virtual pod chosen; its tile shows the first four pods' colours. */
export const AllChosen = meta.story({ args: { selected: "all" } });

/** Personal is chosen, below the divider. */
export const PersonalChosen = meta.story({ args: { selected: "personal" } });

/** Member has no way to make a pod, so the dashed tile is gone. */
export const Member = meta.story({
	args: { onNewPod: undefined },
	play: async ({ canvas }) => {
		await expect(canvas.queryByRole("button", { name: "New pod" })).toBeNull();
	},
});

/** Right-clicking a shared pod: a new bot in it, its settings, and a link to send. */
export const PodMenu = meta.story({
	play: async ({ args, canvas, userEvent }) => {
		await userEvent.pointer({
			keys: "[MouseRight]",
			target: canvas.getByRole("link", { name: "Revenue" }),
		});
		const menu = await screen.findByRole("menu");
		await expect(screen.getByRole("menuitem", { name: "Pod settings" })).toBeInTheDocument();
		await expect(screen.getByRole("menuitem", { name: "Copy link" })).toBeInTheDocument();
		await userEvent.click(screen.getByRole("menuitem", { name: "New bot" }));
		await expect(args.onNewBot).toHaveBeenCalledWith(expect.objectContaining({ slug: "revenue" }));
		// The menu stays mounted while its closing animation plays.
		await waitFor(() => expect(menu).not.toBeInTheDocument());
	},
});

/** Right-clicking All: a new bot in a pod chosen next, or a new pod. */
export const AllMenu = meta.story({
	play: async ({ args, canvas, userEvent }) => {
		await userEvent.pointer({
			keys: "[MouseRight]",
			target: canvas.getByRole("link", { name: "All" }),
		});
		await userEvent.click(await screen.findByRole("menuitem", { name: "New bot" }));
		await expect(args.onNewBot).toHaveBeenCalledWith(undefined);
	},
});

/** Only one workspace: the same tile, whose menu has it, a way to set up another, and its settings. */
export const OneWorkspace = meta.story({
	args: { workspace: suga, workspaces: [suga] },
	play: async ({ canvas, userEvent }) => {
		await userEvent.click(canvas.getByRole("button", { name: "Workspace: Suga" }));
		await screen.findByRole("menu");
		await expect(screen.getAllByRole("menuitem")).toHaveLength(3);
		await expect(screen.getByRole("menuitem", { name: "New workspace" })).toHaveAttribute(
			"href",
			"/onboarding/new",
		);
		await expect(screen.getByRole("menuitem", { name: "Suga" })).toHaveAttribute(
			"aria-current",
			"page",
		);
		await expect(screen.getByRole("menuitem", { name: "Workspace settings" })).toHaveAttribute(
			"href",
			"/suga/settings",
		);
	},
});

/** Several workspaces: the tile at the top names the current one and opens the others. */
export const SwitchWorkspace = meta.story({
	args: { workspace: suga, workspaces: [suga, nitric, longName] },
	play: async ({ canvas, userEvent }) => {
		await userEvent.click(canvas.getByRole("button", { name: "Workspace: Suga" }));
		await screen.findByRole("menu");
		await expect(screen.getByRole("menuitem", { name: "Suga" })).toHaveAttribute(
			"aria-current",
			"page",
		);
		await expect(screen.getByRole("menuitem", { name: "Nitric" })).toHaveAttribute(
			"href",
			"/nitric/agents",
		);
	},
});

/** A long workspace name is cut short in the menu rather than widening it. */
export const LongWorkspaceName = meta.story({
	args: { workspace: longName, workspaces: [suga, nitric, longName] },
	play: async ({ canvas, userEvent }) => {
		await userEvent.click(canvas.getByRole("button", { name: /^Workspace:/ }));
		await expect(await screen.findByRole("menuitem", { name: longName.name })).toBeVisible();
	},
});
