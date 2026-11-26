import { ChevronDown, LayoutTemplate } from "lucide-react";
import { expect, fn, screen, waitFor, within } from "storybook/test";
import preview from "#storybook/preview";
import { LayoutPicker } from "./LayoutPicker.tsx";

const meta = preview.meta({
	title: "Product/LayoutPicker",
	component: LayoutPicker,
	tags: ["ai-generated"],
	args: {
		heading: "Change layout",
		current: "columns",
		onPick: fn(),
		className:
			"focus-ring inline-flex h-8 items-center gap-1.5 rounded-sm px-2 text-soft-foreground text-xs transition-colors hover:bg-hover data-popup-open:bg-hover",
		children: (
			<>
				<LayoutTemplate aria-hidden size={16} strokeWidth={1.75} />
				Two columns
				<ChevronDown aria-hidden size={12} className="text-subtle-foreground" />
			</>
		),
	},
});

/**
 * Changing a slide's layout, with the current one ringed. A slide nobody laid
 * out by hand has nothing to reset, so the picker ends with the layouts.
 */
export const ChangeLayout = meta.story({
	play: async ({ args, canvas, userEvent }) => {
		await userEvent.click(canvas.getByRole("button", { name: /Two columns/ }));
		const picker = within(await screen.findByRole("dialog", { name: "Change layout" }));
		await expect(picker.getByRole("button", { name: "Two columns" })).toHaveAttribute(
			"aria-current",
			"true",
		);
		await expect(picker.queryByRole("button", { name: /Reset layout/ })).toBeNull();
		await userEvent.click(picker.getByRole("button", { name: "Title and bullets" }));
		await expect(args.onPick).toHaveBeenCalledWith("bullets");
		// The accessibility check after the story would otherwise catch the
		// popover's focus guards while it is still closing.
		await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
	},
});

/**
 * A slide somebody laid out by hand, by moving a box or deleting one: the
 * picker ends with a row that puts every box back where its layout places it.
 */
export const WithReset = meta.story({
	args: { onReset: fn() },
	play: async ({ args, canvas, userEvent }) => {
		await userEvent.click(canvas.getByRole("button", { name: /Two columns/ }));
		const picker = within(await screen.findByRole("dialog", { name: "Change layout" }));
		await userEvent.click(picker.getByRole("button", { name: /Reset layout/ }));
		await expect(args.onReset).toHaveBeenCalledOnce();
		await expect(args.onPick).not.toHaveBeenCalled();
		await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
	},
});

/**
 * While a suggestion on the slide waits, no layout can be chosen, but a
 * slide laid out by hand can still be reset.
 */
export const UnavailableWithReset = meta.story({
	args: {
		onReset: fn(),
		unavailable: "Accept or undo the suggestions on this slide to change its layout.",
	},
	play: async ({ canvas, userEvent }) => {
		await userEvent.click(canvas.getByRole("button", { name: /Two columns/ }));
		const picker = within(await screen.findByRole("dialog", { name: "Change layout" }));
		await expect(
			picker.getByText("Accept or undo the suggestions on this slide to change its layout."),
		).toBeVisible();
		await expect(picker.queryByRole("button", { name: "Title and bullets" })).toBeNull();
		await expect(picker.getByRole("button", { name: /Reset layout/ })).toBeVisible();
	},
});
