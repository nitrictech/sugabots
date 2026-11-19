import type { BotColor, BotFace, BotShape, ProjectColor } from "@sugabots/contracts";
import { useState } from "react";
import { expect } from "storybook/test";
import preview from "#storybook/preview";
import { BotAvatar } from "./Bot.tsx";
import { LookPicker, ProjectColourPicker } from "./LookPicker.tsx";
import { ProjectInitial } from "./SidebarProject.tsx";

function Look() {
	const [color, setColor] = useState<BotColor>("green");
	const [shape, setShape] = useState<BotShape>("circle");
	const [face, setFace] = useState<BotFace>("pill");
	return (
		<div className="flex max-w-105 flex-col items-center gap-4 p-4">
			<BotAvatar color={color} face={face} shape={shape} size={96} />
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

function ProjectLook() {
	const [color, setColor] = useState<ProjectColor>("green");
	return (
		<div className="flex max-w-105 flex-col items-center gap-4 rounded-panel bg-list p-4">
			<ProjectInitial project={{ name: "Revenue", color }} size="lg" />
			<ProjectColourPicker value={color} onChange={setColor} />
		</div>
	);
}

/** ProjectColour picks a project's colour from its own palette; the mark above follows it. */
export const ProjectColour = meta.story({
	render: () => <ProjectLook />,
	play: async ({ canvas, userEvent }) => {
		await userEvent.click(canvas.getByRole("radio", { name: "amber" }));
		await expect(canvas.getByRole("radio", { name: "amber" })).toBeChecked();
	},
});
