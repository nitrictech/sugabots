import type { AgentColor, AgentFace } from "@sugabots/contracts";
import { useState } from "react";
import { expect } from "storybook/test";
import preview from "#storybook/preview";
import { AgentAvatar } from "./Agent.tsx";
import { ColourPicker, EyesPicker } from "./LookPickers.tsx";

function Look() {
	const [color, setColor] = useState<AgentColor>("green");
	const [face, setFace] = useState<AgentFace>("pill");
	return (
		<div className="flex max-w-[420px] flex-col items-center gap-4 rounded-panel bg-list p-4">
			<AgentAvatar color={color} face={face} size={96} />
			<ColourPicker value={color} onChange={setColor} />
			<EyesPicker color={color} value={face} onChange={setFace} />
		</div>
	);
}

const meta = preview.meta({
	title: "Product/LookPickers",
	component: ColourPicker,
	tags: ["ai-generated"],
	args: { value: "green" as const, onChange: () => {} },
	render: () => <Look />,
});

/** Pick chooses a colour, then eyes drawn in it; the face above follows both. */
export const Pick = meta.story({
	play: async ({ canvas, userEvent }) => {
		await userEvent.click(canvas.getByRole("radio", { name: "purple" }));
		await expect(canvas.getByRole("radio", { name: "purple" })).toBeChecked();
		await userEvent.click(canvas.getByRole("radio", { name: "wink" }));
		await expect(canvas.getByRole("radio", { name: "wink" })).toBeChecked();
	},
});
