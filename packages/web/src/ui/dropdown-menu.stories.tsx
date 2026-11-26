import { ClipboardPaste, ClipboardType, Copy, RotateCcw, Scissors, Trash2 } from "lucide-react";
import { expect, fn, screen, within } from "storybook/test";
import preview from "#storybook/preview";
import { Button } from "./button.tsx";
import {
	ContextMenu,
	ContextMenuContent,
	ContextMenuTrigger,
	DropdownMenu,
	DropdownMenuContent,
	DropdownMenuItem,
	DropdownMenuSeparator,
	DropdownMenuShortcut,
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

/**
 * A context menu opened over work in progress, such as a slide being edited:
 * compact, so it covers little of the work, each item with the keys that do
 * the same, a separator before what acts on the thing right-clicked, and an
 * item that can't be chosen now saying why under its name.
 */
export const CompactContextMenu = meta.story({
	render: () => (
		<ContextMenu>
			<ContextMenuTrigger className="grid h-40 w-80 place-items-center rounded-lg border border-border-dashed text-muted-foreground text-sm">
				Right-click here
			</ContextMenuTrigger>
			<ContextMenuContent density="compact" className="min-w-48 max-w-80">
				<DropdownMenuItem>
					<Scissors aria-hidden />
					Cut
					<DropdownMenuShortcut>Ctrl+X</DropdownMenuShortcut>
				</DropdownMenuItem>
				<DropdownMenuItem>
					<Copy aria-hidden />
					Copy
					<DropdownMenuShortcut>Ctrl+C</DropdownMenuShortcut>
				</DropdownMenuItem>
				<DropdownMenuItem>
					<ClipboardPaste aria-hidden />
					Paste
					<DropdownMenuShortcut>Ctrl+V</DropdownMenuShortcut>
				</DropdownMenuItem>
				<DropdownMenuItem>
					<ClipboardType aria-hidden />
					Paste without formatting
					<DropdownMenuShortcut>Ctrl+Shift+V</DropdownMenuShortcut>
				</DropdownMenuItem>
				<DropdownMenuSeparator />
				<DropdownMenuItem variant="destructive" disabled>
					<Trash2 aria-hidden />
					<span className="flex flex-col">
						Delete
						<span className="text-muted-foreground text-2xs">
							Turn off Suggesting to delete a box.
						</span>
					</span>
					<DropdownMenuShortcut>Del</DropdownMenuShortcut>
				</DropdownMenuItem>
				<DropdownMenuItem>
					<RotateCcw aria-hidden />
					Reset layout
				</DropdownMenuItem>
			</ContextMenuContent>
		</ContextMenu>
	),
	play: async ({ canvas, userEvent }) => {
		await userEvent.pointer({ keys: "[MouseRight]", target: canvas.getByText("Right-click here") });
		await expect(await screen.findByRole("menu")).toBeVisible();
		for (const [name, keys] of [
			["Cut", "Ctrl+X"],
			["Copy", "Ctrl+C"],
			["Paste", "Ctrl+V"],
			["Paste without formatting", "Ctrl+Shift+V"],
		] as const) {
			const item = screen.getByRole("menuitem", { name: new RegExp(`^${name}\\s*Ctrl`) });
			await expect(within(item).getByText(keys)).toBeVisible();
		}
		await expect(screen.getByRole("separator")).toBeInTheDocument();
		await expect(screen.getByRole("menuitem", { name: /^Delete/ })).toHaveAttribute(
			"aria-disabled",
			"true",
		);
	},
});
