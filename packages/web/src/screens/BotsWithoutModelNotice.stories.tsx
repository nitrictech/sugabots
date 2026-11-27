import { expect } from "storybook/test";
import preview from "#storybook/preview";
import { growthDesk, storyBots } from "@/shell/story-fixtures.test-support.ts";
import { appHandlers, StoryApp, storyWorkspace } from "@/story-app.test-support.tsx";
import { BotsWithoutModelNotice } from "./BotsWithoutModelNotice.tsx";

const meta = preview.meta({
	title: "Product/BotsWithoutModelNotice",
	component: BotsWithoutModelNotice,
	parameters: { layout: "fullscreen" },
	args: { bots: [] },
	beforeEach({ msw }) {
		msw.use(
			...appHandlers({
				bots: storyBots.map((bot) => (bot.id === growthDesk.id ? { ...bot, model: null } : bot)),
			}),
		);
	},
});

/** BotWithoutModel tells a bot’s manager what lets it reply to a new chat. */
export const BotWithoutModel = meta.story({
	render: () => <StoryApp path={`/${storyWorkspace.slug}/bots/${growthDesk.handle}/new`} />,
	play: async ({ canvas }) => {
		await expect(await canvas.findByRole("link", { name: "Choose a model" })).toBeVisible();
	},
});
