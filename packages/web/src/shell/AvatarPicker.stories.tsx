import type { BotColor, BotEyes, BotShape, ProjectColor } from "@sugabots/contracts";
import { useState } from "react";
import { expect } from "storybook/test";
import preview from "#storybook/preview";
import { AvatarPicker, ProjectColourPicker } from "./AvatarPicker.tsx";
import { BotAvatar } from "./Bot.tsx";
import { ProjectInitial } from "./SidebarProject.tsx";

function Look() {
	const [color, setColor] = useState<BotColor>("green");
	const [shape, setShape] = useState<BotShape>("circle");
	const [eyes, setEyes] = useState<BotEyes>("pill");
	return (
		<div className="flex max-w-105 flex-col items-center gap-4 p-4">
			<BotAvatar color={color} eyes={eyes} shape={shape} size={96} />
			<div className="w-full overflow-hidden rounded-panel bg-list">
				<AvatarPicker
					color={color}
					shape={shape}
					eyes={eyes}
					onColorChange={setColor}
					onShapeChange={setShape}
					onEyesChange={setEyes}
				/>
			</div>
		</div>
	);
}

const meta = preview.meta({
	title: "Product/AvatarPicker",
	component: AvatarPicker,
	tags: ["ai-generated"],
	args: {
		color: "green" as const,
		shape: "circle" as const,
		eyes: "pill" as const,
		onColorChange: () => {},
		onShapeChange: () => {},
		onEyesChange: () => {},
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
