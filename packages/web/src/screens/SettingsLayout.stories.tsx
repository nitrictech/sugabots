import { HttpResponse, http } from "msw";
import { expect, screen, waitFor, within } from "storybook/test";
import preview from "#storybook/preview";
import { growthDesk } from "@/shell/story-fixtures.test-support.ts";
import { appHandlers, StoryApp, storyMember, storyWorkspace } from "../story-app.test-support.tsx";

/*
 * Settings as the app shows them: a dialog over the page they were opened on,
 * with the grouped sections down the left and the open one beside them. The
 * address names them in its search, `?settings=` and the section. On a phone
 * they are You's list to drill into, and each section opens full screen with
 * the way back to it.
 */

/** Settings at `section`, over the workspace's home; the list of them with none. */
const settingsAt = (section = "") => `/${storyWorkspace.slug}?settings=${section}`;
/** On a phone, settings at `section` over You, which lists them. */
const phoneSettingsAt = (section: string) => `/${storyWorkspace.slug}/you?settings=${section}`;
const api = (path: string) => `${import.meta.env.VITE_API_URL}${path}`;
const PHONE = { viewport: { value: "iphone12", isRotated: false } };
const TABLET = { viewport: { value: "ipad11p", isRotated: false } };

const meta = preview.meta({
	title: "Views/Settings",
	tags: ["ai-generated"],
	parameters: { layout: "fullscreen" },
	beforeEach({ msw }) {
		msw.use(...appHandlers());
	},
});

/** General: the workspace's name, its time zone and your access, under the trail to it. */
export const General = meta.story({
	render: () => <StoryApp path={settingsAt()} />,
	play: async ({ canvas }) => {
		const nav = await canvas.findByRole("navigation", { name: "Settings" });
		await expect(
			within(within(nav).getByRole("group", { name: "Workspace" })).getByRole("link", {
				name: "General",
			}),
		).toHaveAttribute("aria-current", "page");
		await expect(await canvas.findByText("Time zone")).toBeInTheDocument();
		const trail = canvas.getByRole("navigation", { name: "Breadcrumb" });
		await expect(
			within(trail).getByRole("link", { name: "Workspace settings" }),
		).toBeInTheDocument();
	},
});

/** The owner deleting the workspace: a confirmation that says what goes with it. */
export const DeleteWorkspace = meta.story({
	render: () => <StoryApp path={settingsAt()} />,
	play: async ({ canvas, userEvent }) => {
		await userEvent.click(await canvas.findByRole("button", { name: "Delete workspace" }));
		const dialog = await screen.findByRole("dialog", { name: /^Delete .+\?$/ });
		// The dialog moves focus to Cancel just after it appears.
		await waitFor(() =>
			expect(within(dialog).getByRole("button", { name: "Cancel" })).toHaveFocus(),
		);
	},
});

/** Your General, under You at the head of the navigation: you, your name to change, the theme, and signing out. */
export const Account = meta.story({
	render: () => <StoryApp path={settingsAt("account")} />,
	play: async ({ canvas }) => {
		await expect(
			await canvas.findByRole("heading", { name: storyMember.name }),
		).toBeInTheDocument();
		const nav = canvas.getByRole("navigation", { name: "Settings" });
		await expect(
			within(within(nav).getByRole("group", { name: "You" })).getByRole("link", {
				name: "General",
			}),
		).toHaveAttribute("aria-current", "page");
		await expect(canvas.getByRole("textbox", { name: "Name" })).toHaveValue(storyMember.name);
		await expect(canvas.getByRole("group", { name: "Theme" })).toBeInTheDocument();
		await expect(canvas.getByRole("button", { name: "Sign out" })).toBeInTheDocument();
	},
});

/** Account where sign-up is by referral: your link to copy, and resetting it. */
export const AccountWithReferralLink = meta.story({
	beforeEach({ msw }) {
		msw.use(
			http.post(api("/referral-link/reset"), () =>
				HttpResponse.json({ url: "https://sugabots.example/join/9k2mx7qd4pw3h" }),
			),
			...appHandlers({ referralLink: "https://sugabots.example/join/k7x2p9qa4mz8c" }),
		);
	},
	render: () => <StoryApp path={settingsAt("account")} />,
	play: async ({ canvas, userEvent }) => {
		await expect(
			await canvas.findByRole("heading", { name: "Share your referral link" }),
		).toBeInTheDocument();
		await expect(canvas.getByText(/join\/k7x2p9qa4m/)).toBeInTheDocument();
		await userEvent.click(canvas.getByRole("button", { name: "Reset link" }));
		await expect(await canvas.findByText(/join\/9k2mx7qd4p/)).toBeInTheDocument();
	},
});

/** An editor reads the same sections, less the ones only an administrator may open. */
export const AsAnEditor = meta.story({
	beforeEach({ msw }) {
		msw.use(...appHandlers({ role: "editor" }));
	},
	render: () => <StoryApp path={settingsAt()} />,
	play: async ({ canvas }) => {
		const nav = await canvas.findByRole("navigation", { name: "Settings" });
		await expect(await within(nav).findByRole("link", { name: /^Members/ })).toBeInTheDocument();
		await expect(within(nav).queryByRole("link", { name: "Models" })).toBeNull();
	},
});

/** On a tablet: one list, you first, every section a row that opens it, and no Done. */
export const TabletList = meta.story({
	globals: TABLET,
	render: () => <StoryApp path={settingsAt()} />,
	play: async ({ canvas }) => {
		const list = await canvas.findByRole("navigation", { name: "Settings sections" });
		// The sidebar beside it is the way out, so there is no Done.
		await expect(within(list).queryByRole("link", { name: "Done" })).toBeNull();
		await expect(
			within(list).getByRole("link", { name: /Account and notifications/ }),
		).toHaveAttribute("href", expect.stringMatching(/\?settings=account$/));
		await expect(within(list).getByRole("link", { name: /General/ })).toBeInTheDocument();
	},
});

/** On a phone, settings are the You tab, which the list of them opens. */
export const PhoneList = meta.story({
	globals: PHONE,
	render: () => <StoryApp path={settingsAt()} />,
	play: async ({ canvas }) => {
		await expect(await canvas.findByRole("heading", { level: 1, name: "Settings" })).toBeVisible();
	},
});

/** On a phone, a section opens full screen, with the way back to the You tab's Settings. */
export const PhoneSection = meta.story({
	globals: PHONE,
	render: () => <StoryApp path={phoneSettingsAt("members")} />,
	play: async ({ canvas }) => {
		const page = await canvas.findByRole("main");
		await expect(await within(page).findByRole("link", { name: "Back" })).toHaveAttribute(
			"href",
			`/${storyWorkspace.slug}/you`,
		);
		await expect(await within(page).findByRole("heading", { name: "Members" })).toBeInTheDocument();
	},
});

/**
 * Over a bot's page: the page and the bot's own sidebar stay as they were
 * beneath the dialog, which closes back onto them.
 */
export const OverABotsPage = meta.story({
	render: () => (
		<StoryApp path={`/${storyWorkspace.slug}/bots/${growthDesk.handle}?settings=members`} />
	),
	play: async ({ canvas, userEvent }) => {
		const dialog = await canvas.findByRole("dialog", { name: "Settings" });
		await expect(
			await within(dialog).findByRole("heading", { name: "Members", level: 2 }),
		).toBeVisible();
		await expect(
			await canvas.findByRole("navigation", { name: `${growthDesk.name}'s pages` }),
		).toBeInTheDocument();
		// Once the bot's page beneath has loaded, which hides the app while it does.
		await userEvent.click(await within(dialog).findByRole("link", { name: "Close settings" }));
		await waitFor(() => expect(canvas.queryByRole("dialog", { name: "Settings" })).toBeNull());
		await expect(
			canvas.getByRole("navigation", { name: `${growthDesk.name}'s pages` }),
		).toBeVisible();
	},
});
