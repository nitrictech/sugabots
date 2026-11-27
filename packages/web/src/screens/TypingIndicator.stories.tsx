import { testMember } from "@sugabots/contracts/testing";
import { expect } from "storybook/test";
import preview from "#storybook/preview";
import { type Typer, TypingIndicator } from "./TypingIndicator.tsx";

const growthDesk: Typer = {
	kind: "bot",
	id: "0199a3a0-0000-7000-8000-0000000000a1",
	name: "Growth Desk",
};

const member = (id: string, name: string): Typer =>
	testMember({ id: `0199a3a0-0000-7000-8000-00000000010${id}`, name });

const ana = member("1", "Ana Ortiz");
const ben = member("2", "Ben Lee");
const cleo = member("3", "Cleo Park");
const dev = member("4", "Dev Shah");

const meta = preview.meta({
	title: "Product/TypingIndicator",
	component: TypingIndicator,
	tags: ["ai-generated"],
	args: { typers: [growthDesk] as const },
});

/** Typing is a bot at work on its reply: three moving dots and its name, where the reply will land. */
export const Typing = meta.story({
	play: async ({ canvas }) => {
		await expect(canvas.getByRole("status", { name: "Growth Desk is typing" })).toBeVisible();
	},
});

/** AMember is somebody else writing in the composer. */
export const AMember = meta.story({
	args: { typers: [ana] as const },
	play: async ({ canvas }) => {
		await expect(canvas.getByRole("status", { name: "Ana Ortiz is typing" })).toBeVisible();
	},
});

/** WithTheBot is a member typing while the bot writes its reply: one line names them both. */
export const WithTheBot = meta.story({
	args: { typers: [growthDesk, ana] as const },
	play: async ({ canvas }) => {
		await expect(
			canvas.getByRole("status", { name: "Growth Desk and Ana Ortiz are typing" }),
		).toBeVisible();
	},
});

/** Crowd is more members typing than the line names: two are named, and it counts the rest. */
export const Crowd = meta.story({
	args: { typers: [ana, ben, cleo, dev] as const },
	play: async ({ canvas }) => {
		await expect(
			canvas.getByRole("status", { name: "Ana Ortiz, Ben Lee and 2 others are typing" }),
		).toBeVisible();
	},
});
