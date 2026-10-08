import { expect } from "storybook/test";
import preview from "#storybook/preview";
import { Note } from "./note.tsx";

const meta = preview.meta({
	title: "Controls/Note",
	component: Note,
	tags: ["ai-generated"],
	args: {
		children:
			"Sandboxes are experimental. How they work, and what they keep, may change between releases.",
	},
});

/** A caveat beside settings, read in passing rather than announced. */
export const Default = meta.story({
	play: async ({ canvas }) => {
		await expect(canvas.getByText(/Sandboxes are experimental/)).toBeVisible();
		await expect(canvas.queryByRole("alert")).toBeNull();
	},
});
