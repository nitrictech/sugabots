import { expect } from "storybook/test";
import preview from "#storybook/preview";
import { EmptyState } from "./empty-state.tsx";

const meta = preview.meta({
	title: "Patterns/EmptyState",
	component: EmptyState,
	tags: ["ai-generated"],
	args: {
		title: "No projects yet",
		children: "Its bots, its people and the apps they share are here.",
	},
	render: (args) => (
		<div className="flex min-h-80">
			<EmptyState {...args} />
		</div>
	),
});

/** What is missing, and the one line that says what would fill it. */
export const WithNextStep = meta.story({
	play: async ({ canvas }) => {
		await expect(canvas.getByText("No projects yet")).toBeInTheDocument();
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
