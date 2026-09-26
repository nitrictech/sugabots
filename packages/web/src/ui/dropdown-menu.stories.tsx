import { expect, fn, screen } from "storybook/test";
import preview from "#storybook/preview";
import { Button } from "./button.tsx";
import {
	DropdownMenu,
	DropdownMenuContent,
	DropdownMenuItem,
	DropdownMenuTrigger,
} from "./dropdown-menu.tsx";

const meta = preview.meta({
	title: "Controls/DropdownMenu",
	component: DropdownMenu,
	tags: ["ai-generated"],
	args: { onOpenChange: fn() },
	render: (args) => (
		<DropdownMenu {...args}>
			<DropdownMenuTrigger render={<Button variant="secondary">Add people</Button>} />
			<DropdownMenuContent className="min-w-52">
				<DropdownMenuItem>Jay Young</DropdownMenuItem>
				<DropdownMenuItem>Mara Kent</DropdownMenuItem>
				<DropdownMenuItem disabled>Sam Park is already here</DropdownMenuItem>
				<DropdownMenuItem variant="destructive">Remove everyone</DropdownMenuItem>
			</DropdownMenuContent>
		</DropdownMenu>
	),
});

/** Closed: only its trigger. */
export const Closed = meta.story({
	play: async ({ canvas }) => {
		await expect(canvas.getByRole("button", { name: "Add people" })).toBeInTheDocument();
		await expect(screen.queryByRole("menu")).toBeNull();
	},
});

/** Open: items, one disabled, and a destructive item in red. */
export const Open = meta.story({
	play: async ({ canvas, userEvent }) => {
		await userEvent.click(canvas.getByRole("button", { name: "Add people" }));
		const menu = await screen.findByRole("menu");
		await expect(menu).toBeInTheDocument();
		await expect(screen.getByRole("menuitem", { name: "Remove everyone" })).toBeInTheDocument();
	},
});
