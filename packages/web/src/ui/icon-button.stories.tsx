import { Settings2 } from "lucide-react";
import { fn } from "storybook/test";
import preview from "#storybook/preview";
import { IconButton } from "./icon-button.tsx";

const meta = preview.meta({
	title: "Controls/IconButton",
	component: IconButton,
	tags: ["ai-generated"],
	args: {
		label: "Workspace settings",
		children: <Settings2 size={16} strokeWidth={1.75} />,
		onClick: fn(),
	},
	argTypes: {
		variant: { control: "select", options: ["quiet", "bar", "round"] },
		size: { control: "select", options: ["sm", "default", "lg"] },
	},
});

/** Quiet keeps secondary actions compact while retaining a label and tooltip. */
export const Quiet = meta.story({});

/** Bar sits in the header across the top of a list, chat or sidebar, such as a sidebar's Close. */
export const Bar = meta.story({
	args: { variant: "bar", children: <Settings2 size={16} strokeWidth={2} /> },
});

/** Round is a filled circle, for a Close or a ⋯ beside other controls. */
export const Round = meta.story({ args: { variant: "round" } });

export const Disabled = meta.story({ args: { disabled: true } });
