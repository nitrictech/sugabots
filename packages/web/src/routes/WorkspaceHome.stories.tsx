import { expect } from "storybook/test";
import preview from "#storybook/preview";
import { storyBots } from "@/shell/story-fixtures.test-support.ts";
import { appHandlers, StoryApp, storyWorkspace } from "@/story-app.test-support.tsx";

const meta = preview.meta({
	title: "Views/WorkspaceHome",
	parameters: { layout: "fullscreen" },
});

/**
 * No Personal Assistant: where the workspace opens for a member with none, a
 * way to make one, and nothing for assistants at the sidebar's top.
 */
export const NoAssistant = meta.story({
	beforeEach({ msw }) {
		msw.use(...appHandlers({ bots: storyBots.filter((bot) => !bot.assistant) }));
	},
	render: () => <StoryApp path={`/${storyWorkspace.slug}`} />,
	play: async ({ canvas }) => {
		await expect(await canvas.findByText("You have no Personal Assistant")).toBeVisible();
		await expect(canvas.getByRole("button", { name: "Make a Personal Assistant" })).toBeVisible();
	},
});
