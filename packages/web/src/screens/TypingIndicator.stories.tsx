import { expect } from "storybook/test";
import preview from "#storybook/preview";
import { TypingIndicator } from "./TypingIndicator.tsx";

const meta = preview.meta({
	title: "Product/TypingIndicator",
	component: TypingIndicator,
	tags: ["ai-generated"],
	args: { agent: { name: "Growth Desk", color: "green" as const, face: "pill" as const } },
});

/** Typing is a bot at work on its reply: three dots in its tint, where the reply will land. */
export const Typing = meta.story({
	play: async ({ canvas }) => {
		await expect(canvas.getByRole("status", { name: "Growth Desk is typing" })).toBeVisible();
	},
});

/** OnTheRight is a bot typing on the right, as the host does in a collaboration's mirrored thread. */
export const OnTheRight = meta.story({ args: { outgoing: true } });
