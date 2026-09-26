import { expect } from "storybook/test";
import preview from "#storybook/preview";
import { Textarea } from "./textarea.tsx";

const meta = preview.meta({
	title: "Controls/Textarea",
	component: Textarea,
	tags: ["ai-generated"],
	args: { "aria-label": "Instructions", placeholder: "What should it do each time it runs?" },
	render: (args) => (
		<div style={{ width: 420 }}>
			<Textarea {...args} />
		</div>
	),
});

/** Empty, with its placeholder. */
export const Empty = meta.story({
	play: async ({ canvas }) => {
		await expect(canvas.getByLabelText("Instructions")).toHaveValue("");
	},
});

/** Typed into: it grows to fit what is written. */
export const Typing = meta.story({
	play: async ({ canvas, userEvent }) => {
		const field = canvas.getByLabelText("Instructions");
		await userEvent.type(field, "Review overnight changes.{enter}Summarise anything urgent.");
		await expect(field).toHaveValue("Review overnight changes.\nSummarise anything urgent.");
	},
});

/** Not available, faded. */
export const Disabled = meta.story({
	args: { disabled: true, defaultValue: "Only an admin can change this." },
	play: async ({ canvas }) => {
		await expect(canvas.getByLabelText("Instructions")).toBeDisabled();
	},
});
