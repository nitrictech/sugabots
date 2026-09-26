import { expect } from "storybook/test";
import preview from "#storybook/preview";
import { EmptyState } from "./empty-state.tsx";

const meta = preview.meta({
	title: "Patterns/EmptyState",
	component: EmptyState,
	tags: ["ai-generated"],
	args: {
		title: "No pods yet",
		children: "Its bots, its people and the apps they share are here.",
	},
	render: (args) => (
		<div style={{ display: "flex", minHeight: 320 }}>
			<EmptyState {...args} />
		</div>
	),
});

/** What is missing, and the one line that says what would fill it. */
export const WithNextStep = meta.story({
	play: async ({ canvas }) => {
		await expect(canvas.getByText("No pods yet")).toBeInTheDocument();
		await expect(canvas.getByText(/apps they share/)).toBeInTheDocument();
	},
});

/** A title alone, where there is nothing more to say. */
export const TitleOnly = meta.story({
	args: { title: "No such workspace here", children: undefined },
	play: async ({ canvas }) => {
		await expect(canvas.getByText("No such workspace here")).toBeInTheDocument();
	},
});
