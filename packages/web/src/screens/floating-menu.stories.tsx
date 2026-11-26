import {
	Bold,
	ChevronDown,
	Italic,
	Link2,
	Sparkles,
	Strikethrough,
	Type,
	Underline,
} from "lucide-react";
import { expect, screen, within } from "storybook/test";
import preview from "#storybook/preview";
import { IconButton } from "@/ui/icon-button.tsx";
import { FloatingMenu, MenuDivider } from "./floating-menu.tsx";

/** The least room `FloatingMenu` keeps from the window's edges, which these stories check it keeps. */
const WINDOW_MARGIN_PX = 16;

/** How far in from the window's right edge the menu is put, nearer than it fits. */
const NEAR_RIGHT_EDGE_PX = 48;

/** What the menu for selected text holds: asking a bot, the text's style, and its formatting. */
function SelectedTextTools() {
	return (
		<>
			<button
				type="button"
				className="focus-ring flex h-6 items-center gap-1.5 rounded-md px-2 font-medium text-suggestion text-xs transition-colors hover:bg-hover"
			>
				<Sparkles aria-hidden size={13} />
				Edit with bot
			</button>
			<MenuDivider />
			<button
				type="button"
				aria-label="Text style, now Text"
				className="focus-ring flex h-6 items-center gap-1.5 rounded-md pr-1 pl-1.5 text-foreground text-xs transition-colors hover:bg-hover"
			>
				<Type aria-hidden size={14} className="text-muted-foreground" />
				Text
				<ChevronDown aria-hidden size={12} className="text-subtle-foreground" />
			</button>
			<MenuDivider />
			<IconButton label="Bold" side="top">
				<Bold aria-hidden />
			</IconButton>
			<IconButton label="Italic" side="top">
				<Italic aria-hidden />
			</IconButton>
			<IconButton label="Underline" side="top">
				<Underline aria-hidden />
			</IconButton>
			<IconButton label="Strikethrough" side="top">
				<Strikethrough aria-hidden />
			</IconButton>
			<MenuDivider />
			<IconButton label="Link" side="top">
				<Link2 aria-hidden />
			</IconButton>
		</>
	);
}

/** How many rows `toolbar`'s controls are laid out in, by where each one's middle is. */
function rowsOf(toolbar: HTMLElement): number {
	const middles = within(toolbar)
		.getAllByRole("button")
		.map((button) => {
			const { top, height } = button.getBoundingClientRect();
			return Math.round(top + height / 2);
		});
	return new Set(middles).size;
}

const meta = preview.meta({
	title: "Product/FloatingMenu",
	component: FloatingMenu,
	tags: ["ai-generated"],
	parameters: { layout: "fullscreen" },
	args: { label: "Selected text", at: { top: 160, left: 24 }, children: <SelectedTextTools /> },
});

/**
 * Over words selected near the window's right edge, the menu keeps its full
 * width, its tools in one row, and moves left until it is inside the
 * window's margin.
 */
export const NearTheRightEdge = meta.story({
	render: (args) => (
		<FloatingMenu {...args} at={{ top: 160, left: window.innerWidth - NEAR_RIGHT_EDGE_PX }} />
	),
	play: async () => {
		const toolbar = await screen.findByRole("toolbar", { name: "Selected text" });
		const { left, right } = toolbar.getBoundingClientRect();
		await expect(right).toBeLessThanOrEqual(window.innerWidth - WINDOW_MARGIN_PX + 0.5);
		await expect(left).toBeLessThan(window.innerWidth - NEAR_RIGHT_EDGE_PX);
		await expect(rowsOf(toolbar)).toBe(1);
	},
});

/**
 * In a window too narrow for its tools, as a phone's, the menu fills the room
 * between the margins, and its tools wrap onto a second row above the
 * selected words, its foot staying where it was put.
 */
export const WrapsOnAPhone = meta.story({
	args: { at: { top: 320, left: 120 } },
	globals: { viewport: { value: "mobile1" } },
	play: async ({ args }) => {
		const toolbar = await screen.findByRole("toolbar", { name: "Selected text" });
		const { left, right, bottom } = toolbar.getBoundingClientRect();
		await expect(left).toBeCloseTo(WINDOW_MARGIN_PX, 0);
		await expect(right).toBeCloseTo(window.innerWidth - WINDOW_MARGIN_PX, 0);
		await expect(bottom).toBeCloseTo(args.at.top, 0);
		await expect(rowsOf(toolbar)).toBe(2);
	},
});
