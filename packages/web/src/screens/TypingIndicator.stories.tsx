import { testPerson } from "@sugabots/contracts/testing";
import { expect } from "storybook/test";
import preview from "#storybook/preview";
import { type Typer, TypingIndicator } from "./TypingIndicator.tsx";

const growthDesk: Typer = {
	kind: "agent",
	id: "0199a3a0-0000-7000-8000-0000000000a1",
	name: "Growth Desk",
	color: "green",
	face: "pill",
};

const person = (id: string, name: string): Typer =>
	testPerson({ id: `0199a3a0-0000-7000-8000-00000000010${id}`, name });

const ana = person("1", "Ana Ortiz");
const ben = person("2", "Ben Lee");
const cleo = person("3", "Cleo Park");
const dev = person("4", "Dev Shah");

const meta = preview.meta({
	title: "Product/TypingIndicator",
	component: TypingIndicator,
	tags: ["ai-generated"],
	args: { typers: [growthDesk] as const },
});

/** Typing is a bot at work on its reply: three dots in its tint, where the reply will land. */
export const Typing = meta.story({
	play: async ({ canvas }) => {
		await expect(canvas.getByRole("status", { name: "Growth Desk is typing" })).toBeVisible();
	},
});

/** OnTheRight is a bot typing on the right, as the host does in a collaboration's mirrored thread. */
export const OnTheRight = meta.story({ args: { outgoing: true } });

/** APerson is somebody else writing in the composer, in the bubble people's messages have. */
export const APerson = meta.story({
	args: { typers: [ana] as const },
	play: async ({ canvas }) => {
		await expect(canvas.getByRole("status", { name: "Ana Ortiz is typing" })).toBeVisible();
	},
});

/** WithTheBot is a person typing while the bot writes its reply: one bubble, their faces stacked. */
export const WithTheBot = meta.story({
	args: { typers: [growthDesk, ana] as const },
	play: async ({ canvas }) => {
		await expect(
			canvas.getByRole("status", { name: "Growth Desk and Ana Ortiz are typing" }),
		).toBeVisible();
	},
});

/** Crowd is more people typing than there are faces: three stack, and the label counts the rest. */
export const Crowd = meta.story({
	args: { typers: [ana, ben, cleo, dev] as const },
	play: async ({ canvas }) => {
		await expect(
			canvas.getByRole("status", { name: "Ana Ortiz, Ben Lee and 2 others are typing" }),
		).toBeVisible();
	},
});
