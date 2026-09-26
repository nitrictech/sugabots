import { useState } from "react";
import { expect, fn } from "storybook/test";
import preview from "#storybook/preview";
import { SegmentedControl } from "./segmented-control.tsx";

const themes = [
	{ value: "dark", label: "Dark" },
	{ value: "light", label: "Light" },
	{ value: "system", label: "System" },
] as const;

function Theme() {
	const [value, setValue] = useState<(typeof themes)[number]["value"]>("dark");
	return <SegmentedControl label="Theme" options={themes} value={value} onChange={setValue} />;
}

const meta = preview.meta({
	title: "Controls/SegmentedControl",
	component: SegmentedControl,
	tags: ["ai-generated"],
	args: { label: "Theme", options: themes, value: "dark", onChange: fn() },
	render: () => <Theme />,
});

/** Pick shows a short pick-one choice; clicking an option chooses it. */
export const Pick = meta.story({
	play: async ({ canvas, userEvent }) => {
		await userEvent.click(canvas.getByRole("radio", { name: "Light" }));
		await expect(canvas.getByRole("radio", { name: "Light" })).toBeChecked();
	},
});

/** Keyboard moves the choice with the arrow keys, keeping only the chosen option tabbable. */
export const Keyboard = meta.story({
	play: async ({ canvas, userEvent }) => {
		await userEvent.tab();
		await expect(canvas.getByRole("radio", { name: "Dark" })).toHaveFocus();
		await userEvent.keyboard("{ArrowRight}");
		await expect(canvas.getByRole("radio", { name: "Light" })).toBeChecked();
		await expect(canvas.getByRole("radio", { name: "Light" })).toHaveFocus();
	},
});
