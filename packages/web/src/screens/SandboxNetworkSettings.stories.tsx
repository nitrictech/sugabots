import type { SandboxNetworkSettings } from "@sugabots/contracts";
import { expect, fn } from "storybook/test";
import preview from "#storybook/preview";
import { SettingsPage } from "@/ui/settings-page.tsx";
import { SandboxNetworkGroups } from "./SandboxNetworkSettings.tsx";

const trustedHosts = [
	"github.com",
	"*.github.com",
	"*.githubusercontent.com",
	"registry.npmjs.org",
	"pypi.org",
	"files.pythonhosted.org",
	"deb.debian.org",
];

const settings: SandboxNetworkSettings = {
	trustedHosts,
	addedHosts: [
		{
			host: "api.stripe.com",
			addedByName: "Sam Rivera",
			addedAt: "2026-10-01T09:30:00.000Z",
		},
		{
			host: "*.internal.example.com",
			addedByName: "Kim Park",
			addedAt: "2026-10-02T02:10:00.000Z",
		},
	],
	blockedHosts: [
		{ host: "*.pastebin.com", blockedByName: "Kim Park", blockedAt: "2026-10-03T01:00:00.000Z" },
	],
};

const meta = preview.meta({
	title: "Views/SandboxNetworkSettings",
	component: SandboxNetworkGroups,
	tags: ["ai-generated"],
	parameters: { layout: "fullscreen" },
	args: {
		settings,
		pending: false,
		onAdd: fn(async () => undefined),
		onRemove: fn(),
		onBlock: fn(async () => undefined),
		onUnblock: fn(),
	},
	decorators: [
		(Story) => (
			<div className="flex min-h-screen flex-col bg-background">
				<SettingsPage title="Sandboxes" description="Where bots run commands and edit files.">
					<Story />
				</SettingsPage>
			</div>
		),
	],
});

/**
 * Hosts the workspace added, each with who added it.
 */
export const AddedHosts = meta.story({
	play: async ({ canvas, args, userEvent }) => {
		await expect(canvas.getByText("api.stripe.com")).toBeVisible();
		await expect(canvas.getByText(/Added by Sam Rivera/)).toBeVisible();

		await userEvent.type(canvas.getByLabelText("Add host"), "Docs.Example.com");
		await userEvent.click(canvas.getByRole("button", { name: "Add" }));
		await expect(args.onAdd).toHaveBeenCalledWith("docs.example.com");

		await userEvent.click(canvas.getByRole("button", { name: "Remove api.stripe.com" }));
		await expect(args.onRemove).toHaveBeenCalledWith("api.stripe.com");
	},
});

/** Hosts blocked for every pod, and blocking or unblocking one. */
export const BlockedHosts = meta.story({
	play: async ({ canvas, args, userEvent }) => {
		await expect(canvas.getByText("*.pastebin.com")).toBeVisible();
		await expect(canvas.getByText("Blocked by Kim Park")).toBeVisible();

		await userEvent.type(canvas.getByLabelText("Block host"), "paste.example.com");
		await userEvent.click(canvas.getByRole("button", { name: "Block" }));
		await expect(args.onBlock).toHaveBeenCalledWith("paste.example.com");

		await userEvent.click(canvas.getByRole("button", { name: "Unblock *.pastebin.com" }));
		await expect(args.onUnblock).toHaveBeenCalledWith("*.pastebin.com");
	},
});

/** Only the trusted hosts, listed once asked for. */
export const TrustedOnly = meta.story({
	args: { settings: { trustedHosts, addedHosts: [], blockedHosts: [] } },
	play: async ({ canvas, userEvent }) => {
		await userEvent.click(canvas.getByText("Trusted hosts"));
		await expect(canvas.getByText(/registry\.npmjs\.org/)).toBeVisible();
	},
});

/** A host the API refused, said under the group. */
export const Refused = meta.story({
	args: { error: new Error("Enter a domain name, such as api.example.com or *.example.com") },
});
