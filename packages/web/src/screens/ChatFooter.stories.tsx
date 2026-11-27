import { expect } from "storybook/test";
import preview from "#storybook/preview";
import { growthDesk, revenue, storyBots } from "@/shell/story-fixtures.test-support.ts";
import {
	appHandlers,
	chatPath,
	StoryApp,
	storyProjectChatFor,
	storyWorkspace,
} from "@/story-app.test-support.tsx";

/*
 * The foot of a chat: the composer, saying whom a message goes to, and under
 * it which bots will reply. While a bot that must reply has no model, it says
 * so and holds Send.
 */

const meta = preview.meta({
	title: "Product/Chat Footer",
	parameters: { layout: "fullscreen" },
});

/** ToABot is a bot's own chat: the composer names the chat, and Send waits for a message. */
export const ToABot = meta.story({
	beforeEach({ msw }) {
		msw.use(...appHandlers());
	},
	render: () => <StoryApp path={chatPath(growthDesk)} />,
	play: async ({ canvas, userEvent }) => {
		const composer = await canvas.findByRole("textbox", { name: /^Message / });
		await userEvent.type(composer, "Draft the pricing replies");
		await expect(composer).toHaveTextContent("Draft the pricing replies");
	},
});

/** BotWithoutAModel is a chat whose bot has no model yet: the composer says how to choose one. */
export const BotWithoutAModel = meta.story({
	beforeEach({ msw }) {
		msw.use(
			...appHandlers({
				bots: storyBots.map((bot) => (bot.id === growthDesk.id ? { ...bot, model: null } : bot)),
			}),
		);
	},
	render: () => <StoryApp path={chatPath(growthDesk)} />,
	play: async ({ canvas }) => {
		await expect(await canvas.findByRole("link", { name: "Choose a model" })).toBeVisible();
	},
});

/** InAProject is a project's chat, where a message goes to the project's lead bot unless it names others. */
export const InAProject = meta.story({
	beforeEach({ msw }) {
		msw.use(...appHandlers());
	},
	render: () => (
		<StoryApp
			path={`/${storyWorkspace.slug}/projects/${revenue.slug}/${storyProjectChatFor(revenue).id}`}
		/>
	),
	play: async ({ canvas }) => {
		await expect(await canvas.findByRole("textbox", { name: /^Message / })).toBeVisible();
	},
});
