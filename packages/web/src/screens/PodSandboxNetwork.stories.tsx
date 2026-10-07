import type { PodSandboxNetwork } from "@sugabots/contracts";
import { expect, fn } from "storybook/test";
import preview from "#storybook/preview";
import { SettingsPage } from "@/ui/settings-page.tsx";
import { PodNetworkGroup } from "./PodSandboxNetwork.tsx";

const network: PodSandboxNetwork = {
	workspaceHosts: [
		{ host: "github.com", blockedBy: null },
		{ host: "registry.npmjs.org", blockedBy: null },
		{ host: "api.example.com", blockedBy: "api.example.com" },
	],
	addedHosts: [
		{
			host: "api.stripe.com",
			addedByName: "Sam Rivera",
			addedAt: "2026-10-01T09:30:00.000Z",
			blockedBy: null,
		},
		{
			host: "*.pastebin.com",
			addedByName: "Kim Park",
			addedAt: "2026-10-02T02:10:00.000Z",
			blockedBy: "*.pastebin.com",
		},
	],
};

const meta = preview.meta({
	title: "Views/PodSandboxNetwork",
	component: PodNetworkGroup,
	tags: ["ai-generated"],
	parameters: { layout: "fullscreen" },
	args: {
		network,
		canManage: true,
		pending: false,
		onAdd: fn(async () => undefined),
		onRemove: fn(),
	},
	decorators: [
		(Story) => (
			<div className="flex min-h-screen flex-col bg-background">
				<SettingsPage title="Builders">
					<Story />
				</SettingsPage>
			</div>
		),
	],
});

/**
 * The pod's own hosts, one of them kept out by the workspace's block, to
 * someone who may change them.
 */
export const PodHosts = meta.story({
	play: async ({ canvas, args, userEvent }) => {
		await expect(canvas.getByText(/Added by Sam Rivera/)).toBeVisible();
		await expect(canvas.getByText(/Blocked for the workspace by \*\.pastebin\.com/)).toBeVisible();

		await userEvent.type(canvas.getByLabelText("Add host"), "Docs.Example.com");
		await userEvent.click(canvas.getByRole("button", { name: "Add" }));
		await expect(args.onAdd).toHaveBeenCalledWith("docs.example.com");

		await userEvent.click(canvas.getByRole("button", { name: "Remove api.stripe.com" }));
		await expect(args.onRemove).toHaveBeenCalledWith("api.stripe.com");
	},
});

/** The workspace's hosts every pod reaches, less the blocked, listed once asked for. */
export const FromTheWorkspace = meta.story({
	play: async ({ canvas, userEvent }) => {
		await expect(canvas.getByText(/2 hosts every pod reaches/)).toBeVisible();
		await userEvent.click(canvas.getByText("From the workspace"));
		await expect(canvas.getByText("github.com, registry.npmjs.org")).toBeVisible();
	},
});

/** Someone who may not change the pod's hosts sees them, without adding or removing. */
export const ReadOnly = meta.story({
	args: { canManage: false },
	play: async ({ canvas }) => {
		await expect(canvas.getByText("api.stripe.com")).toBeVisible();
		await expect(canvas.queryByLabelText("Add host")).toBeNull();
		await expect(canvas.queryByRole("button", { name: "Remove api.stripe.com" })).toBeNull();
		await expect(canvas.getByText(/an admin of this pod decides/)).toBeVisible();
	},
});
