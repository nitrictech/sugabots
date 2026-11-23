import { expect } from "storybook/test";
import preview from "#storybook/preview";
import { Button } from "./button.tsx";
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

/** The ways to fill it, under the line that names them, each on a line of its own. */
export const WithActions = meta.story({
	args: {
		title: "This page could not load",
		children: "Reload the page to try again.",
		actions: (
			<>
				<Button variant="secondary">Reload</Button>
				<span>Or ask an admin to look into it.</span>
			</>
		),
	},
	play: async ({ canvas }) => {
		await expect(canvas.getByRole("button", { name: "Reload" })).toBeVisible();
		await expect(canvas.getByText("Or ask an admin to look into it.")).toBeVisible();
	},
});

/** Compact, in a phone's sheet: no padding of its own, and its actions as wide as the sheet. */
export const Compact = meta.story({
	args: {
		compact: true,
		title: "Computers aren't set up yet",
		children: "They're set up once, for the whole workspace.",
		actions: <Button className="h-11 w-full text-sm">Set up computers</Button>,
	},
	render: (args) => (
		<div className="w-90 rounded-dialog bg-background p-4">
			<EmptyState {...args} />
		</div>
	),
	play: async ({ canvas }) => {
		await expect(canvas.getByRole("button", { name: "Set up computers" })).toBeVisible();
	},
});
