import { Download, Trash2 } from "lucide-react";
import { expect, screen } from "storybook/test";
import preview from "#storybook/preview";
import { DropdownMenuItem } from "./dropdown-menu.tsx";
import { MoreMenu } from "./more-menu.tsx";

const meta = preview.meta({
	title: "Controls/MoreMenu",
	component: MoreMenu,
	tags: ["ai-generated"],
	args: { children: <></> },
	render: ({ label }) => (
		<MoreMenu label={label}>
			<DropdownMenuItem>
				<Download aria-hidden />
				Download
			</DropdownMenuItem>
			<DropdownMenuItem variant="destructive">
				<Trash2 aria-hidden />
				Delete
			</DropdownMenuItem>
		</MoreMenu>
	),
});

/** Closed: only the ⋯. */
export const Closed = meta.story({
	play: async ({ canvas }) => {
		await expect(canvas.getByRole("button", { name: "More" })).toBeVisible();
		await expect(screen.queryByRole("menu")).toBeNull();
	},
});

/** Open: its actions, a destructive one in red. */
export const Open = meta.story({
	play: async ({ canvas, userEvent }) => {
		await userEvent.click(canvas.getByRole("button", { name: "More" }));
		await expect(await screen.findByRole("menuitem", { name: "Download" })).toBeVisible();
		await expect(screen.getByRole("menuitem", { name: "Delete" })).toBeVisible();
	},
});

/** Named for whose actions they are, where a page has several. */
export const Labelled = meta.story({
	args: { label: "More for Wiki" },
	play: async ({ canvas }) => {
		await expect(canvas.getByRole("button", { name: "More for Wiki" })).toBeVisible();
	},
});
