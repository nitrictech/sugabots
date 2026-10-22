import type { AgentColor, AgentFace, AgentShape, PodColor } from "@sugabots/contracts";
import { useState } from "react";
import { expect } from "storybook/test";
import preview from "#storybook/preview";
import { AgentAvatar } from "./Agent.tsx";
import { LookPicker, PodColourPicker } from "./LookPicker.tsx";
import { PodTile } from "./PodTile.tsx";

function Look() {
	const [color, setColor] = useState<AgentColor>("green");
	const [shape, setShape] = useState<AgentShape>("circle");
	const [face, setFace] = useState<AgentFace>("pill");
	return (
		<div className="flex max-w-[420px] flex-col items-center gap-4 p-4">
			<AgentAvatar color={color} face={face} shape={shape} size={96} />
			<div className="w-full overflow-hidden rounded-panel bg-list">
				<LookPicker
					color={color}
					shape={shape}
					face={face}
					onColorChange={setColor}
					onShapeChange={setShape}
					onFaceChange={setFace}
				/>
			</div>
		</div>
	);
}

const meta = preview.meta({
	title: "Product/LookPicker",
	component: LookPicker,
	tags: ["ai-generated"],
	args: {
		color: "green" as const,
		shape: "circle" as const,
		face: "pill" as const,
		onColorChange: () => {},
		onShapeChange: () => {},
		onFaceChange: () => {},
	},
	render: () => <Look />,
});

/** Pick chooses a colour, a shape, then eyes; the face above follows all three. */
export const Pick = meta.story({
	play: async ({ canvas, userEvent }) => {
		await userEvent.click(canvas.getByRole("radio", { name: "purple" }));
		await expect(canvas.getByRole("radio", { name: "purple" })).toBeChecked();
		await userEvent.click(canvas.getByRole("radio", { name: "star" }));
		await expect(canvas.getByRole("radio", { name: "star" })).toBeChecked();
		await userEvent.click(canvas.getByRole("radio", { name: "wink" }));
		await expect(canvas.getByRole("radio", { name: "wink" })).toBeChecked();
	},
});

function PodLook() {
	const [color, setColor] = useState<PodColor>("green");
	return (
		<div className="flex max-w-[420px] flex-col items-center gap-4 rounded-panel bg-list p-4">
			<PodTile bots={[{ color: "sky", face: "pill" }]} color={color} size={72} />
			<PodColourPicker value={color} onChange={setColor} />
		</div>
	);
}

/** PodColour picks a pod's colour from its own palette; the tile above follows it. */
export const PodColour = meta.story({
	render: () => <PodLook />,
	play: async ({ canvas, userEvent }) => {
		await userEvent.click(canvas.getByRole("radio", { name: "amber" }));
		await expect(canvas.getByRole("radio", { name: "amber" })).toBeChecked();
	},
});
