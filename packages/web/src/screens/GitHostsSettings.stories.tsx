import type { GitHost } from "@sugabots/contracts";
import { expect, fn, within } from "storybook/test";
import preview from "#storybook/preview";
import { SettingsPage } from "@/ui/settings-page.tsx";
import { GitHostsGroup } from "./GitHostsSettings.tsx";

const installed: GitHost = {
	id: "0199b0f2-6a4e-7c1d-9a52-3c5e1f2d4b6a",
	kind: "github",
	name: "Acme Sugabots",
	account: "acme",
	settingsUrl: "https://github.com/apps/acme-sugabots",
	createdAt: "2026-10-05T09:30:00.000Z",
};

const notInstalled: GitHost = {
	id: "0199b0f2-6a4e-7c1d-9a52-3c5e1f2d4b6b",
	kind: "github",
	name: "Sam's Sugabots",
	account: null,
	settingsUrl: "https://github.com/apps/sams-sugabots",
	createdAt: "2026-10-06T01:10:00.000Z",
};

const meta = preview.meta({
	title: "Views/GitHostsSettings",
	component: GitHostsGroup,
	tags: ["ai-generated"],
	parameters: { layout: "fullscreen" },
	args: {
		hosts: [installed, notInstalled],
		pending: false,
		onMake: fn(),
		onInstall: fn(),
		onRemove: fn(async () => undefined),
	},
	decorators: [
		(Story) => (
			<div className="flex min-h-screen flex-col bg-background">
				<SettingsPage title="Sandboxes">
					<Story />
				</SettingsPage>
			</div>
		),
	],
});

/** One app installed on an organization, one made but not installed yet. */
export const Apps = meta.story({
	play: async ({ canvas, args, userEvent }) => {
		await expect(canvas.getByText("Installed on acme")).toBeVisible();
		await expect(canvas.getByRole("link", { name: "On GitHub" })).toHaveAttribute(
			"href",
			installed.settingsUrl,
		);
		await userEvent.click(canvas.getByRole("button", { name: "Install" }));
		await expect(args.onInstall).toHaveBeenCalledWith(notInstalled.id);
	},
});

/** Making an app for an organization, or, left empty, for the person's own account. */
export const MakeApp = meta.story({
	args: { hosts: [] },
	play: async ({ canvas, args, userEvent }) => {
		await userEvent.click(canvas.getByRole("button", { name: "Make on GitHub" }));
		await expect(args.onMake).toHaveBeenLastCalledWith(undefined);
		await userEvent.type(canvas.getByLabelText("New app"), "acme");
		await userEvent.click(canvas.getByRole("button", { name: "Make on GitHub" }));
		await expect(args.onMake).toHaveBeenLastCalledWith("acme");
	},
});

/** Removing an app asks first, and says it stays on GitHub. */
export const Remove = meta.story({
	play: async ({ canvas, args, userEvent }) => {
		await userEvent.click(canvas.getByRole("button", { name: "Remove Acme Sugabots" }));
		const dialog = within(document.body).getByRole("dialog");
		await expect(within(dialog).getByText(/stays on GitHub/)).toBeVisible();
		await userEvent.click(within(dialog).getByRole("button", { name: "Remove" }));
		await expect(args.onRemove).toHaveBeenCalledWith(installed.id);
	},
});
