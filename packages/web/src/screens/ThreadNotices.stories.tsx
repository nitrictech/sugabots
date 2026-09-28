import { expect } from "storybook/test";
import preview from "#storybook/preview";
import { ThreadNotices } from "./ThreadNotices.tsx";

const meta = preview.meta({
	title: "Product/ThreadNotices",
	component: ThreadNotices,
	tags: ["ai-generated"],
	args: { notices: [] },
});

/** OneNotice is a thread told why the agent it asked will not reply. */
export const OneNotice = meta.story({
	args: {
		notices: [{ id: "n1", text: "Growth Desk has no model chosen, so it cannot reply." }],
	},
	play: async ({ canvas }) => {
		await expect(
			canvas.getByText("Growth Desk has no model chosen, so it cannot reply."),
		).toBeVisible();
	},
});

/** None draws nothing, keeping only the status region a notice is announced in. */
export const None = meta.story({});
