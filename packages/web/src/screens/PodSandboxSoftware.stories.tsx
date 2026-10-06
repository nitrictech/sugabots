import type { PodSandboxSoftware } from "@sugabots/contracts";
import { expect, fn } from "storybook/test";
import preview from "#storybook/preview";
import { SettingsPage } from "@/ui/settings-page.tsx";
import { SoftwareGroup } from "./PodSandboxSoftware.tsx";

const software: PodSandboxSoftware = {
	packages: [
		{
			name: "ffmpeg",
			channel: "stable",
			nixpkgsRev: "0d9e9b832d03ac387417e16ce1febf73b2e631e1",
			addedByName: "Sam Rivera",
			addedAt: "2026-10-05T09:30:00.000Z",
		},
		{
			name: "terraform",
			channel: "unstable",
			nixpkgsRev: "494ce7fd23ff6a5dff39e1fb11e9b6f2ac74bf25",
			addedByName: null,
			addedAt: "2026-10-06T01:10:00.000Z",
		},
	],
};

const meta = preview.meta({
	title: "Views/PodSandboxSoftware",
	component: SoftwareGroup,
	tags: ["ai-generated"],
	parameters: { layout: "fullscreen" },
	args: { software, canManage: true, pending: false, onRemove: fn() },
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

/** The pod's software, one package from unstable, to someone who may remove them. */
export const Packages = meta.story({
	play: async ({ canvas, args, userEvent }) => {
		await expect(canvas.getByText("Allowed by Sam Rivera")).toBeVisible();
		await expect(canvas.getByText("Unstable")).toBeVisible();
		await userEvent.click(canvas.getByRole("button", { name: "Remove ffmpeg" }));
		await expect(args.onRemove).toHaveBeenCalledWith("ffmpeg", "stable");
	},
});

/** Someone who may not change the pod's sandbox sees its software without removing any. */
export const ReadOnly = meta.story({
	args: { canManage: false },
	play: async ({ canvas }) => {
		await expect(canvas.getByText("ffmpeg")).toBeVisible();
		await expect(canvas.queryByRole("button", { name: "Remove ffmpeg" })).toBeNull();
	},
});

/** Nothing installed beyond the image yet. */
export const None = meta.story({
	args: { software: { packages: [] } },
	play: async ({ canvas }) => {
		await expect(canvas.getByText("None yet")).toBeVisible();
	},
});
