import { expect } from "storybook/test";
import preview from "#storybook/preview";
import { appHandlers, StoryApp, storyWorkspace } from "@/story-app.test-support.tsx";
import { ProjectsDirectory } from "./ProjectsDirectory.tsx";

const meta = preview.meta({
	title: "Views/ProjectsDirectory",
	component: ProjectsDirectory,
	parameters: { layout: "fullscreen" },
	beforeEach({ msw }) {
		msw.use(...appHandlers());
	},
});

/** WorkspaceDirectory shows the projects the member can open. */
export const WorkspaceDirectory = meta.story({
	render: () => <StoryApp path={`/${storyWorkspace.slug}/projects`} />,
	play: async ({ canvas }) => {
		await expect(await canvas.findByRole("heading", { level: 1, name: "Projects" })).toBeVisible();
	},
});
