// The dialog is portalled to the body, so reaching it means `screen`.
import { expect, screen, within } from "storybook/test";
import preview from "#storybook/preview";
import type { RunningBuild } from "@/lib/help.ts";
import { Dialog } from "@/ui/dialog.tsx";
import { AboutDialog } from "./HelpMenu.tsx";

const environment = { browser: "Chrome 141", system: "macOS" };

function known(version: string, commit?: string): RunningBuild {
	return { state: "known", build: { version, versioned: version !== "unknown", commit } };
}

const meta = preview.meta({
	title: "Product/AboutDialog",
	component: AboutDialog,
	tags: ["ai-generated"],
	args: {
		running: known("0.2.0", "338298a"),
		environment,
	},
	render: (args) => (
		<Dialog open>
			<AboutDialog {...args} />
		</Dialog>
	),
});

/** A release: its version and commit, the browser and system, and a button that copies all four. */
export const Release = meta.story({
	play: async () => {
		const dialog = await screen.findByRole("dialog", { name: "Sugabots" });
		await expect(within(dialog).getByText("0.2.0")).toBeVisible();
		await expect(within(dialog).getByText("338298a")).toBeVisible();
		await expect(within(dialog).getByText("Chrome 141")).toBeVisible();
		await expect(within(dialog).getByRole("button", { name: "Copy debug info" })).toBeEnabled();
	},
});

/** A build without a version, such as `bun run dev`, asks to be told how Sugabots was installed. */
export const Unversioned = meta.story({
	args: { running: known("unknown") },
	play: async () => {
		const dialog = await screen.findByRole("dialog", { name: "Sugabots" });
		await expect(within(dialog).getByText("Unknown")).toBeVisible();
		await expect(within(dialog).getByText("Not recorded")).toBeVisible();
		await expect(within(dialog).getByText(/say how you installed Sugabots/)).toBeVisible();
	},
});

/** Still asking the API which build it is, so there is nothing to copy yet. */
export const Checking = meta.story({
	args: { running: { state: "checking" } satisfies RunningBuild },
	play: async () => {
		const dialog = await screen.findByRole("dialog", { name: "Sugabots" });
		await expect(within(dialog).getAllByText("Checking…")).toHaveLength(2);
		await expect(within(dialog).getByRole("button", { name: "Copy debug info" })).toBeDisabled();
	},
});

/** The API couldn't say which build it is; the browser and system can still be copied. */
export const Unavailable = meta.story({
	args: { running: { state: "unavailable" } satisfies RunningBuild },
	play: async () => {
		const dialog = await screen.findByRole("dialog", { name: "Sugabots" });
		await expect(within(dialog).getAllByText("Not available")).toHaveLength(2);
		await expect(within(dialog).getByRole("button", { name: "Copy debug info" })).toBeEnabled();
	},
});

/** On a phone About rises from the bottom as a sheet. */
export const Phone = meta.story({
	globals: { viewport: { value: "iphone12", isRotated: false } },
});
