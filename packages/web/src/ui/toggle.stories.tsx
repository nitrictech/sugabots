import { useState } from "react";
import { expect, fn, screen, waitFor } from "storybook/test";
import preview from "#storybook/preview";
import { Toggle } from "./toggle.tsx";

/** HeldOffLater renders a switch that starts enabled and becomes disabled once clicked on, like a switch disabled by data that loads after the first render. */
function HeldOffLater() {
	const [on, setOn] = useState(false);
	return (
		<Toggle
			label="Bots can search the web"
			checked={on}
			disabled={on}
			tooltip={on ? "Held off" : "Toggle to enable"}
			onChange={setOn}
		/>
	);
}

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

/** Hovering says what a click will do. */
export const WithTooltip = meta.story({
	args: { tooltip: "Toggle to enable Search the web for Scout" },
	play: async ({ canvas, userEvent }) => {
		await userEvent.hover(canvas.getByRole("switch"));
		await waitFor(() =>
			expect(screen.getByText("Toggle to enable Search the web for Scout")).toBeVisible(),
		);
	},
});

/** Disabled: hovering still shows why, though the disabled button itself receives no mouse events. */
export const DisabledWithTooltip = meta.story({
	args: {
		checked: false,
		disabled: true,
		tooltip:
			"Disabled while web access is off for the workspace. Ask a workspace admin to enable it.",
	},
	play: async ({ canvas, args, userEvent }) => {
		const toggle = canvas.getByRole("switch");
		await userEvent.hover(toggle);
		await waitFor(() =>
			expect(screen.getByText(/Ask a workspace admin to enable it/)).toBeVisible(),
		);
		await userEvent.click(toggle);
		await expect(args.onChange).not.toHaveBeenCalled();
	},
});

/** Disabled after the first render: hovering still shows the tooltip. */
export const DisabledAfterRender = meta.story({
	render: () => <HeldOffLater />,
	play: async ({ canvas, userEvent }) => {
		const toggle = canvas.getByRole("switch");
		await userEvent.click(toggle);
		await expect(toggle).toBeDisabled();
		await userEvent.unhover(toggle);
		await userEvent.hover(toggle);
		await waitFor(() => expect(screen.getByText("Held off")).toBeVisible());
	},
});
