import { expect } from "storybook/test";
import preview from "#storybook/preview";
import { ChatNotices } from "./ChatNotices.tsx";

const meta = preview.meta({
	title: "Product/ChatNotices",
	component: ChatNotices,
	tags: ["ai-generated"],
	args: { notices: [] },
});

/** OneNotice is a chat told why the bot it asked will not reply. */
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
