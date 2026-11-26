import { HttpResponse, http } from "msw";
import { expect, within } from "storybook/test";
import preview from "#storybook/preview";
import { appHandlers, StoryApp, storyWorkspace } from "@/story-app.test-support.tsx";
import { BotsDirectory } from "./BotsDirectory.tsx";
import { chief, deputy, storyBots } from "./story-fixtures.test-support.ts";

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

/**
 * Several Personal Assistants: the member's own lead the directory, oldest
 * first, under Yours, whose + makes them another.
 */
export const SeveralAssistants = meta.story({
	beforeEach({ msw }) {
		msw.use(...appHandlers({ bots: [deputy, ...storyBots] }));
	},
	render: () => <StoryApp path={`/${storyWorkspace.slug}/bots`} />,
	play: async ({ canvas }) => {
		const yours = await canvas.findByRole("region", { name: "Yours" });
		const names = within(yours)
			.getAllByRole("link")
			.map((link) => link.textContent);
		await expect(names).toEqual([chief.name, deputy.name]);
		await expect(
			within(yours).getByRole("button", { name: "New Personal Assistant" }),
		).toBeVisible();
	},
});

/** On a phone, the member can try again when making a Personal Assistant fails. */
export const AssistantCreationErrorOnPhone = meta.story({
	globals: { theme: "light", viewport: { value: "iphone12", isRotated: false } },
	beforeEach({ msw }) {
		msw.use(
			http.post(
				"*/workspaces/:workspace/assistants",
				() => new HttpResponse(null, { status: 500 }),
			),
			...appHandlers({ bots: [] }),
		);
	},
	render: () => <StoryApp path={`/${storyWorkspace.slug}/bots`} />,
	play: async ({ canvas, userEvent }) => {
		await expect(await canvas.findByText("You have no Personal Assistant")).toBeVisible();
		const create = canvas.getByRole("button", { name: "New Personal Assistant" });
		const { width, height } = create.getBoundingClientRect();
		await expect(Math.min(width, height)).toBeGreaterThanOrEqual(44);
		await userEvent.click(create);
		await expect(await canvas.findByRole("alert")).toBeVisible();
		await expect(create).toBeEnabled();
	},
});
