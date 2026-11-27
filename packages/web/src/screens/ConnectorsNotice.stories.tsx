import { expect } from "storybook/test";
import preview from "#storybook/preview";
import { growthDesk } from "@/shell/story-fixtures.test-support.ts";
import { appHandlers, chatPath, connectorHandlers, StoryApp } from "@/story-app.test-support.tsx";
import { expiredLinear } from "./ConnectorsNotice.test-support.ts";

const meta = preview.meta({
	title: "Product/Connectors Notice",
	parameters: { layout: "fullscreen" },
	beforeEach({ msw }) {
		msw.use(...connectorHandlers([expiredLinear]), ...appHandlers());
	},
});

/** ExpiredSignIn shows the notice beside the composer where a member can act on it. */
export const ExpiredSignIn = meta.story({
	render: () => <StoryApp path={chatPath(growthDesk)} />,
	play: async ({ canvas }) => {
		await expect(await canvas.findByRole("button", { name: "Sign in to Linear" })).toBeVisible();
	},
});
