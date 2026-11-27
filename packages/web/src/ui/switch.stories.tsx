import { useState } from "react";
import { expect, fn, screen, waitFor } from "storybook/test";
import preview from "#storybook/preview";
import { Switch } from "./switch.tsx";
import { Tooltip } from "./tooltip.tsx";

function Switchable({ initial }: { initial: boolean }) {
	const [on, setOn] = useState(initial);
	return <Switch aria-label="Bots can search the web" checked={on} onCheckedChange={setOn} />;
}

const meta = preview.meta({
	title: "Controls/Switch",
	component: Switch,
	args: { "aria-label": "Bots can search the web", checked: false, onCheckedChange: fn() },
});

/** Off, and switched on with a click. */
export const Off = meta.story({
	render: () => <Switchable initial={false} />,
	play: async ({ canvas, userEvent }) => {
		const control = canvas.getByRole("switch", { name: "Bots can search the web" });
		await expect(control).toHaveAttribute("aria-checked", "false");
		await userEvent.click(control);
		await expect(control).toHaveAttribute("aria-checked", "true");
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
		await expect(args.onCheckedChange).not.toHaveBeenCalled();
	},
});

/** Disabled, with a tooltip on a wrapper saying why: the switch itself receives no pointer events. */
export const DisabledWithTooltip = meta.story({
	args: { checked: false, disabled: true },
	render: (args) => (
		<Tooltip label="Ask a workspace admin to turn on web access first." side="top">
			<span className="inline-flex shrink-0">
				<Switch {...args} />
			</span>
		</Tooltip>
	),
	play: async ({ canvas, args, userEvent }) => {
		const control = canvas.getByRole("switch");
		await userEvent.hover(control);
		await waitFor(() =>
			expect(screen.getByText(/Ask a workspace admin to turn on web access/)).toBeVisible(),
		);
		await userEvent.click(control);
		await expect(args.onCheckedChange).not.toHaveBeenCalled();
	},
});
