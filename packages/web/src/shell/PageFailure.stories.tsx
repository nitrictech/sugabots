import { expect } from "storybook/test";
import preview from "#storybook/preview";
import { PageFailure } from "./PageFailure.tsx";

const meta = preview.meta({
	title: "Product/PageFailure",
	component: PageFailure,
	tags: ["ai-generated"],
	parameters: { layout: "fullscreen" },
	decorators: [
		(Story) => (
			<div className="flex h-120">
				<Story />
			</div>
		),
	],
});

/** In place of a page that failed to load or render, with the way out. */
export const Default = meta.story({
	play: async ({ canvas }) => {
		await expect(canvas.getByText("This page could not load")).toBeInTheDocument();
		await expect(canvas.getByRole("button", { name: "Reload" })).toBeEnabled();
	},
});
