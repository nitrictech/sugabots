import { expect, fn, waitFor, within } from "storybook/test";
import preview from "#storybook/preview";
import { EmojiPicker } from "./emoji-picker.tsx";

/** Where the picker keeps the emoji last chosen in this browser. */
const RECENT_KEY = "sugabots-recent-emoji";

const meta = preview.meta({
	title: "Controls/EmojiPicker",
	component: EmojiPicker,
	tags: ["ai-generated"],
	args: { onSelect: fn() },
	// Each story starts with nothing chosen before, unless it says otherwise.
	beforeEach() {
		localStorage.removeItem(RECENT_KEY);
		return () => localStorage.removeItem(RECENT_KEY);
	},
	parameters: {
		a11y: {
			config: {
				rules: [
					{
						// Frimousse numbers its grid's rows and columns from 0, where ARIA starts at 1, and
						// finds a row by that number to scroll it into view, so it cannot be renumbered here.
						id: "aria-valid-attr-value",
						selector: "[frimousse-row], [frimousse-emoji]",
						enabled: false,
					},
				],
			},
		},
	},
	decorators: [
		(Story) => (
			<div className="w-fit rounded-lg border border-border-strong bg-panel shadow-popover">
				<Story />
			</div>
		),
	],
});

/** Every emoji by category. Typing narrows them, and choosing one gives it. */
export const Default = meta.story({
	play: async ({ args, canvas, canvasElement, userEvent }) => {
		await canvas.findByRole("gridcell", { name: "Grinning face" }, { timeout: 5_000 });
		await userEvent.click(canvas.getByRole("searchbox", { name: "Search emoji" }));
		await userEvent.keyboard("rocket");
		await chooseSearched(canvasElement, "Rocket", userEvent);
		await expect(args.onSelect).toHaveBeenCalledWith("🚀");
	},
});

/** A search that matches nothing says so. */
export const NothingFound = meta.story({
	play: async ({ canvas, userEvent }) => {
		await canvas.findByRole("gridcell", { name: "Grinning face" }, { timeout: 5_000 });
		await userEvent.click(canvas.getByRole("searchbox", { name: "Search emoji" }));
		await userEvent.keyboard("zzzzqq");
		await expect(await canvas.findByText("No emoji found")).toBeVisible();
	},
});

/**
 * The emoji last chosen sit over the grid, newest first, until a search
 * hides them. Choosing one moves it to the front.
 */
export const Recent = meta.story({
	beforeEach() {
		localStorage.setItem(RECENT_KEY, JSON.stringify(["👀", "🎉", "👍🏽"]));
	},
	play: async ({ args, canvas, userEvent }) => {
		const recent = canvas.getByRole("region", { name: "Recent" });
		await expect(
			await within(recent).findByRole("button", { name: "Party popper" }, { timeout: 5_000 }),
		).toBeVisible();
		await expect(
			within(recent)
				.getAllByRole("button")
				.map((button) => button.textContent),
		).toEqual(["👀", "🎉", "👍🏽"]);
		await userEvent.click(within(recent).getByRole("button", { name: "Party popper" }));
		await expect(args.onSelect).toHaveBeenCalledWith("🎉");
		await expect(
			within(recent)
				.getAllByRole("button")
				.map((button) => button.textContent),
		).toEqual(["🎉", "👀", "👍🏽"]);
		await userEvent.click(canvas.getByRole("searchbox", { name: "Search emoji" }));
		await userEvent.keyboard("rocket");
		await expect(canvas.queryByRole("region", { name: "Recent" })).toBeNull();
	},
});

/** Nothing chosen yet in this browser, so there is no recent row. */
export const NoneRecent = meta.story({
	play: async ({ canvas }) => {
		await canvas.findByRole("gridcell", { name: "Grinning face" }, { timeout: 5_000 });
		await expect(canvas.queryByRole("region", { name: "Recent" })).toBeNull();
	},
});

/**
 * Chooses the emoji the picker's search has narrowed to, once it has settled.
 * The picker applies a search when the page is idle and may lay its rows out
 * again after the first results show, so the emoji is hovered until the
 * picker marks it as the one under the pointer, and only then clicked.
 */
async function chooseSearched(
	picker: HTMLElement,
	name: string,
	user: { hover: (element: Element) => Promise<void>; click: (element: Element) => Promise<void> },
): Promise<void> {
	const cell = () => {
		expect(within(picker).queryByRole("gridcell", { name: "Grinning face" })).toBeNull();
		return within(picker).getByRole("gridcell", { name });
	};
	await waitFor(
		async () => {
			await user.hover(cell());
			expect(cell()).toHaveAttribute("aria-selected", "true");
		},
		{ timeout: 5_000 },
	);
	await user.click(cell());
}
