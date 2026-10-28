import { expect, screen, within } from "storybook/test";
import preview from "#storybook/preview";
import { growthDesk, revenue } from "@/shell/story-fixtures.ts";
import { appHandlers, StoryApp, storyWorkspace } from "@/story-app.tsx";

/*
 * Home on a phone: the pods as tiles down the left, beside the pod shown,
 * with its artifacts, channels and bots, and the tabs along the foot; a
 * bot's page; and You.
 */

const meta = preview.meta({
	title: "Views/Mobile home",
	tags: ["ai-generated"],
	parameters: { layout: "fullscreen" },
	globals: { viewport: { value: "iphone12", isRotated: false } },
	beforeEach({ msw }) {
		msw.use(...appHandlers());
	},
	render: () => <StoryApp path={`/${storyWorkspace.slug}/pods/${revenue.slug}`} />,
});

/** A pod open: its tile marked, its name, Artifacts, its channels and its bots, and the tabs. */
export const Default = meta.story({
	play: async ({ canvas }) => {
		const pods = await canvas.findByRole("navigation", { name: "Pods" }, { timeout: 10_000 });
		await expect(within(pods).getByRole("link", { name: revenue.name })).toHaveAttribute(
			"aria-current",
			"page",
		);
		const pod = canvas.getByRole("region", { name: revenue.name });
		await expect(within(pod).getByRole("link", { name: "Artifacts" })).toBeVisible();
		await expect(
			await within(pod).findByRole("link", { name: new RegExp(`^${growthDesk.name}`) }),
		).toHaveAttribute("href", expect.stringMatching(/\/pods\/revenue\/bots\//));
		const tabs = canvas.getByRole("navigation", { name: "Tabs" });
		await expect(within(tabs).getByRole("link", { name: /^Home/ })).toHaveAttribute(
			"aria-current",
			"page",
		);
	},
});

/** New thread asks, in a sheet, which of the pod's bots it is with. */
export const NewThread = meta.story({
	play: async ({ canvas, userEvent }) => {
		await userEvent.click(
			await canvas.findByRole("button", { name: "New thread" }, { timeout: 10_000 }),
		);
		const sheet = await screen.findByRole("dialog", { name: "New thread with" });
		await expect(await within(sheet).findByRole("link", { name: growthDesk.name })).toHaveAttribute(
			"href",
			expect.stringContaining(`agent=${growthDesk.handle}`),
		);
	},
});

/** A bot's page: Back, a new thread, its name, its routines and its threads. */
export const BotPage = meta.story({
	render: () => (
		<StoryApp path={`/${storyWorkspace.slug}/pods/${revenue.slug}/bots/${growthDesk.handle}`} />
	),
	play: async ({ canvas }) => {
		const page = await canvas.findByRole("region", { name: growthDesk.name }, { timeout: 10_000 });
		await expect(within(page).getByRole("link", { name: /^Routines/ })).toBeVisible();
		await expect(
			within(page).getByRole("link", { name: `New thread with ${growthDesk.name}` }),
		).toBeVisible();
	},
});

/** You: who you are, the workspace and its pods, your account, and Sign out, with its tab marked. */
export const You = meta.story({
	render: () => <StoryApp path={`/${storyWorkspace.slug}/you`} />,
	play: async ({ canvas }) => {
		const page = await canvas.findByRole("region", { name: "You" }, { timeout: 10_000 });
		await expect(within(page).getByRole("link", { name: /^Preferences/ })).toBeVisible();
		await expect(
			await within(page).findByRole("link", { name: new RegExp(`^${revenue.name}`) }),
		).toHaveAttribute("href", expect.stringMatching(/\/settings\/pods\/revenue$/));
		await expect(within(page).getByRole("button", { name: "Sign out" })).toBeVisible();
		const tabs = canvas.getByRole("navigation", { name: "Tabs" });
		await expect(within(tabs).getByRole("link", { name: /^You/ })).toHaveAttribute(
			"aria-current",
			"page",
		);
	},
});
