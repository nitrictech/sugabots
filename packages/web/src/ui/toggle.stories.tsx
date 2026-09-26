import { useState } from "react";
import { expect, fn } from "storybook/test";
import preview from "#storybook/preview";
import { Toggle } from "./toggle.tsx";

function Switchable({ initial }: { initial: boolean }) {
	const [on, setOn] = useState(initial);
	return <Toggle label="Bots can search the web" checked={on} onChange={setOn} />;
}

const meta = preview.meta({
	title: "Controls/Toggle",
	component: Toggle,
	tags: ["ai-generated"],
	args: { label: "Bots can search the web", checked: false, onChange: fn() },
});

/** Off, and switched on with a click. */
export const Off = meta.story({
	render: () => <Switchable initial={false} />,
	play: async ({ canvas, userEvent }) => {
		const toggle = canvas.getByRole("switch", { name: "Bots can search the web" });
		await expect(toggle).toHaveAttribute("aria-checked", "false");
		await userEvent.click(toggle);
		await expect(toggle).toHaveAttribute("aria-checked", "true");
	},
});

/** On, in the accent. */
export const On = meta.story({
	render: () => <Switchable initial />,
	play: async ({ canvas }) => {
		await expect(canvas.getByRole("switch")).toHaveAttribute("aria-checked", "true");
	},
});

/** Not yours to change: faded, and a click does nothing. */
export const Disabled = meta.story({
	args: { checked: true, disabled: true },
	play: async ({ canvas, args, userEvent }) => {
		await userEvent.click(canvas.getByRole("switch"));
		await expect(args.onChange).not.toHaveBeenCalled();
	},
});
