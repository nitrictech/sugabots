import { expect, userEvent } from "storybook/test";
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
		await userEvent.click(canvas.getByText("Browse bots", { selector: "a" }));
		await expect(canvas.queryByText("No such bot here")).toBeNull();
	},
});

export const MissingProject = meta.story({
	parameters: {
		docs: {
			description: { story: "Find other projects when a project link no longer opens." },
		},
	},
	render: () => <StoryApp path={`/${storyWorkspace.slug}/projects/old-roadmap`} />,
	play: async ({ canvas }) => {
		await expect(await canvas.findByText("No such project here")).toBeVisible();
		await userEvent.click(canvas.getByText("Browse projects", { selector: "a" }));
		await expect(canvas.queryByText("No such project here")).toBeNull();
	},
});
