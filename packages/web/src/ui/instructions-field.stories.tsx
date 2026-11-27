import preview from "#storybook/preview";
import { InstructionsField } from "./instructions-field.tsx";

const meta = preview.meta({
	title: "Controls/InstructionsField",
	component: InstructionsField,
});

/** BotInstructions shows an editable set of instructions for a bot. */
export const BotInstructions = meta.story({
	args: {
		defaultValue:
			"Sort new issues by urgency and area. Ask for the steps to reproduce when an issue leaves them out.",
		className: "max-w-lg bg-panel",
	},
});
