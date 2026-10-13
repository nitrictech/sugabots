import { expect, fn } from "storybook/test";
import preview from "#storybook/preview";
import { CloseButton } from "./close-button.tsx";

const meta = preview.meta({
	title: "Controls/CloseButton",
	component: CloseButton,
	tags: ["ai-generated"],
	args: { onClick: fn() },
});

/** Named "Close" unless told what it closes. */
export const Default = meta.story({
	play: async ({ args, canvas, userEvent }) => {
		await userEvent.click(canvas.getByRole("button", { name: "Close" }));
		await expect(args.onClick).toHaveBeenCalled();
	},
});

/** Named for what it closes, such as Settings. */
export const Labelled = meta.story({ args: { label: "Close settings" } });
