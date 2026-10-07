import { Settings } from "lucide-react";
import { fn } from "storybook/test";
import preview from "#storybook/preview";
import { IconButton } from "./icon-button.tsx";

const meta = preview.meta({
	title: "Controls/IconButton",
	component: IconButton,
	tags: ["ai-generated"],
	args: { label: "Workspace settings", children: <Settings />, onClick: fn() },
	argTypes: {
		variant: { control: "select", options: ["quiet", "outline", "pane", "bar"] },
		size: { control: "select", options: ["sm", "default", "lg"] },
	},
});

/** Quiet keeps secondary actions compact while retaining a label and tooltip. */
export const Quiet = meta.story({});

/** Outline separates a standalone icon control from its surroundings. */
export const Outline = meta.story({ args: { variant: "outline" } });

/** Pane uses a recessed background for actions inside a panel. */
export const Pane = meta.story({ args: { variant: "pane", size: "lg" } });

/** Bar sits in the header across the top of a list, chat or sidebar, such as a sidebar's Close. */
export const Bar = meta.story({
	args: { variant: "bar", children: <Settings size={16} strokeWidth={2} /> },
});

export const Disabled = meta.story({ args: { disabled: true } });
