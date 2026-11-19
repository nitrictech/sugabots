import { fn } from "storybook/test";
import preview from "#storybook/preview";
import { Button } from "./button.tsx";

const meta = preview.meta({
	title: "Controls/Button",
	component: Button,
	tags: ["ai-generated"],
	args: { children: "Save changes", onClick: fn() },
	argTypes: {
		variant: {
			control: "select",
			options: [
				"default",
				"secondary",
				"muted",
				"outline",
				"ghost",
				"link",
				"destructive",
				"quiet",
			],
		},
		size: { control: "select", options: ["sm", "default", "lg", "bare", "text"] },
	},
});

/** Primary represents the main action in a form or view. */
export const Primary = meta.story({});

/** Secondary gives supporting actions less emphasis than the primary action. */
export const Secondary = meta.story({
	args: { variant: "secondary", children: "Cancel" },
});

/** Destructive makes an irreversible action visually distinct. */
export const Destructive = meta.story({
	args: { variant: "destructive", children: "Delete workspace" },
});

/** Disabled keeps an unavailable action visible while preventing activation. */
export const Disabled = meta.story({
	args: { disabled: true },
});

/** Quiet text, as View all beside a list, at the size of a row's small text. */
export const QuietText = meta.story({
	args: { variant: "quiet", size: "text", children: "View all" },
});
