import { expect } from "storybook/test";
import preview from "#storybook/preview";
import { appHandlers, StoryApp, storyWorkspace } from "@/story-app.test-support.tsx";
import { BotsDirectory } from "./BotsDirectory.tsx";

const meta = preview.meta({
	title: "Views/BotsDirectory",
	component: BotsDirectory,
	parameters: { layout: "fullscreen" },
	beforeEach({ msw }) {
		msw.use(...appHandlers());
	},
});

/** WorkspaceDirectory shows the bots the member can open. */
export const WorkspaceDirectory = meta.story({
	render: () => <StoryApp path={`/${storyWorkspace.slug}/bots`} />,
	play: async ({ canvas }) => {
		await expect(await canvas.findByRole("heading", { level: 1, name: "Bots" })).toBeVisible();
	},
});
