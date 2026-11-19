import { expect, fn } from "storybook/test";
import preview from "#storybook/preview";
import { NotInTheWorkspace } from "./NotInTheWorkspace.tsx";

const meta = preview.meta({
	title: "Product/NotInTheWorkspace",
	component: NotInTheWorkspace,
	tags: ["ai-generated"],
	parameters: { layout: "fullscreen" },
	args: { onSignOut: fn() },
	decorators: [
		(Story) => (
			<div className="h-120">
				<Story />
			</div>
		),
	],
});

/** Signed in, in no workspace, on a server whose one workspace is somebody else's. */
export const Default = meta.story({
	play: async ({ canvas, userEvent, args }) => {
		await expect(canvas.getByText("You're not in this server's workspace")).toBeVisible();
		await userEvent.click(canvas.getByRole("button", { name: "Sign out" }));
		await expect(args.onSignOut).toHaveBeenCalledOnce();
	},
});
