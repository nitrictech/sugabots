import { HttpResponse, http } from "msw";
import { expect } from "storybook/test";
import preview from "#storybook/preview";
import { storyBots } from "@/shell/story-fixtures.test-support.ts";
import { appHandlers, StoryApp, storyWorkspace } from "@/story-app.test-support.tsx";
import { personalBot } from "./BotRestrictions.test-support.ts";

const meta = preview.meta({
	title: "Views/Bot Restrictions",
	parameters: { layout: "fullscreen" },
	beforeEach({ msw }) {
		msw.use(
			http.get(
				`${import.meta.env.VITE_API_URL}/projects/${personalBot.defaultProjectId}/connectors`,
				() =>
					HttpResponse.json([
						{
							id: "0199a3a0-0000-7000-8000-000000000171",
							name: "Linear",
							enabled: true,
							restricted: true,
						},
						{
							id: "0199a3a0-0000-7000-8000-000000000172",
							name: "Slack",
							enabled: false,
							restricted: true,
						},
					]),
			),
			...appHandlers({ bots: [...storyBots, personalBot], role: "admin" }),
		);
	},
});

/** PersonalBotConnectors shows which connectors an admin can switch off for someone else's personal bot. */
export const PersonalBotConnectors = meta.story({
	render: () => <StoryApp path={`/${storyWorkspace.slug}/bots/${personalBot.handle}/connectors`} />,
	play: async ({ canvas }) => {
		await expect(
			await canvas.findByRole("switch", { name: "Turn off Linear", checked: true }),
		).toBeEnabled();
		await expect(
			canvas.getByRole("switch", { name: "Turn off Slack", checked: false }),
		).toBeDisabled();
	},
});
