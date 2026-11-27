import { expect, within } from "storybook/test";
import preview from "#storybook/preview";
import { deputy, storyBots } from "@/shell/story-fixtures.test-support.ts";
import { appHandlers, StoryApp, storyWorkspace } from "@/story-app.test-support.tsx";

/*
 * Home on a phone: the member's Personal Assistants, then the projects they
 * are in and the bots they pinned, each opening its chats, with the way to
 * browse the rest. `Views/Phone` shows it with the example workspace as it is.
 */

const meta = preview.meta({
	title: "Product/Mobile Home",
	parameters: { layout: "fullscreen" },
	globals: { viewport: { value: "iphone12", isRotated: false } },
	render: () => <StoryApp path={`/${storyWorkspace.slug}/home`} />,
});

/** TwoAssistants puts each of the member's Personal Assistants at the top, oldest first. */
export const TwoAssistants = meta.story({
	beforeEach({ msw }) {
		msw.use(...appHandlers({ bots: [...storyBots, deputy] }));
	},
	play: async ({ canvas }) => {
		const chief = await canvas.findByRole("link", { name: /^Chief/ });
		const second = canvas.getByRole("link", { name: /^Deputy/ });
		await expect(
			chief.compareDocumentPosition(second) & Node.DOCUMENT_POSITION_FOLLOWING,
		).toBeTruthy();
	},
});

/** NoProjects is a member in no project yet: only the way to browse them is left. */
export const NoProjects = meta.story({
	beforeEach({ msw }) {
		msw.use(...appHandlers({ projects: [] }));
	},
	play: async ({ canvas }) => {
		const projects = await canvas.findByRole("region", { name: "Projects" });
		await expect(
			within(projects)
				.getAllByRole("link")
				.map((link) => link.textContent),
		).toEqual(["Browse projects"]);
	},
});

/** NothingPinned is a member who pinned no bot: Bots holds only the way to browse them. */
export const NothingPinned = meta.story({
	beforeEach({ msw }) {
		msw.use(
			...appHandlers({
				bots: storyBots.map((bot) => (bot.assistant ? bot : { ...bot, pinned: false })),
			}),
		);
	},
	play: async ({ canvas }) => {
		const bots = await canvas.findByRole("region", { name: "Bots" });
		await expect(
			within(bots)
				.getAllByRole("link")
				.map((link) => link.textContent),
		).toEqual(["Browse bots"]);
	},
});
