import { expect } from "storybook/test";
import preview from "#storybook/preview";
import { growthDesk } from "@/shell/story-fixtures.test-support.ts";
import { appHandlers, StoryApp, storyWorkspace } from "@/story-app.test-support.tsx";

const meta = preview.meta({
	title: "Views/New Chat Page",
	parameters: { layout: "fullscreen" },
	beforeEach({ msw }) {
		msw.use(...appHandlers());
	},
});

/** NewBotChat shows the empty composer where a member starts a chat with a bot. */
export const NewBotChat = meta.story({
	render: () => <StoryApp path={`/${storyWorkspace.slug}/bots/${growthDesk.handle}/new`} />,
	play: async ({ canvas }) => {
		await expect(await canvas.findByRole("textbox", { name: "Message Growth Desk" })).toBeVisible();
	},
});
