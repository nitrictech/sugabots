import { useState } from "react";
import { expect } from "storybook/test";
import preview from "#storybook/preview";
import { RadioGroup, RadioGroupItem } from "./radio-group.tsx";

const themes = [
	{ value: "dark", label: "Dark" },
	{ value: "light", label: "Light" },
	{ value: "system", label: "System" },
] as const;

function Theme({ disabled = false }: { disabled?: boolean }) {
	const [value, setValue] = useState<(typeof themes)[number]["value"]>("dark");
	return (
		<RadioGroup aria-label="Theme" value={value} onValueChange={setValue} disabled={disabled}>
			{themes.map((option) => (
				<RadioGroupItem key={option.value} value={option.value}>
					{option.label}
				</RadioGroupItem>
			))}
		</RadioGroup>
	);
}

const meta = preview.meta({
	title: "Controls/RadioGroup",
	component: RadioGroup,
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

/** Not yours to change: faded, and a click does nothing. */
export const Disabled = meta.story({
	render: () => <Theme disabled />,
	play: async ({ canvas, userEvent }) => {
		await userEvent.click(canvas.getByRole("radio", { name: "Light" }));
		await expect(canvas.getByRole("radio", { name: "Dark" })).toBeChecked();
	},
});
