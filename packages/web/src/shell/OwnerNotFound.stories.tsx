import { expect } from "storybook/test";
import preview from "#storybook/preview";
import { appHandlers, StoryApp, storyWorkspace } from "@/story-app.test-support.tsx";

const meta = preview.meta({
	title: "Views/Owner Not Found",
	parameters: { layout: "fullscreen" },
	beforeEach({ msw }) {
		msw.use(...appHandlers());
	},
});

/** MissingBot shows what a member sees when a saved bot address no longer opens. */
export const MissingBot = meta.story({
	render: () => <StoryApp path={`/${storyWorkspace.slug}/bots/old-drafting-desk`} />,
	play: async ({ canvas }) => {
		await expect(await canvas.findByText("No such bot here")).toBeVisible();
	},
});
