import { HttpResponse, http } from "msw";
import { expect, screen, within } from "storybook/test";
import preview from "#storybook/preview";
import { appHandlers, StoryApp, storyUser, storyWorkspace } from "../story-app.tsx";

/*
 * Settings as the app shows them: the grouped sections down the left, the open
 * one beside them. On a phone, `/settings` is one list to drill into, and each
 * section opens full screen with the way back to it.
 */

const settings = `/${storyWorkspace.slug}/settings`;
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
	render: () => <StoryApp path={settings} />,
	play: async ({ canvas }) => {
		const nav = await canvas.findByRole("navigation", { name: "Settings" }, { timeout: 10_000 });
		await expect(
			within(within(nav).getByRole("group", { name: "Workspace" })).getByRole("link", {
				name: "General",
			}),
		).toHaveAttribute("aria-current", "page");
		await expect(await canvas.findByText("Time zone", {}, { timeout: 10_000 })).toBeInTheDocument();
		const trail = canvas.getByRole("navigation", { name: "Breadcrumb" });
		await expect(
			within(trail).getByRole("link", { name: "Workspace settings" }),
		).toBeInTheDocument();
	},
});

/** The owner deleting the workspace: a confirmation that says what goes with it. */
export const DeleteWorkspace = meta.story({
	render: () => <StoryApp path={settings} />,
	play: async ({ canvas, userEvent }) => {
		await userEvent.click(
			await canvas.findByRole("button", { name: "Delete workspace" }, { timeout: 10_000 }),
		);
		const dialog = await screen.findByRole("dialog", { name: /^Delete .+\?$/ });
		await expect(within(dialog).getByRole("button", { name: "Cancel" })).toHaveFocus();
	},
});

/** Your General, under You at the head of the navigation: you, your name to change, the theme, and signing out. */
export const Profile = meta.story({
	render: () => <StoryApp path={`${settings}/profile`} />,
	play: async ({ canvas }) => {
		await expect(
			await canvas.findByRole("heading", { name: storyUser.name }, { timeout: 10_000 }),
		).toBeInTheDocument();
		const nav = canvas.getByRole("navigation", { name: "Settings" });
		await expect(
			within(within(nav).getByRole("group", { name: "You" })).getByRole("link", {
				name: "General",
			}),
		).toHaveAttribute("aria-current", "page");
		await expect(canvas.getByRole("textbox", { name: "Name" })).toHaveValue(storyUser.name);
		await expect(canvas.getByRole("group", { name: "Theme" })).toBeInTheDocument();
		await expect(canvas.getByRole("button", { name: "Sign out" })).toBeInTheDocument();
	},
});

/** Profile where sign-up is by referral: your link to copy, and resetting it. */
export const ProfileWithReferralLink = meta.story({
	beforeEach({ msw }) {
		msw.use(
			http.post(api("/referral-link/reset"), () =>
				HttpResponse.json({ url: "https://sugabots.example/join/9k2mx7qd4pw3h" }),
			),
			...appHandlers({ referralLink: "https://sugabots.example/join/k7x2p9qa4mz8c" }),
		);
	},
	render: () => <StoryApp path={`${settings}/profile`} />,
	play: async ({ canvas, userEvent }) => {
		await expect(
			await canvas.findByRole("heading", { name: "Share your invite link" }, { timeout: 10_000 }),
		).toBeInTheDocument();
		await expect(canvas.getByText(/join\/k7x2p9qa4m/)).toBeInTheDocument();
		await userEvent.click(canvas.getByRole("button", { name: "Reset link" }));
		await expect(await canvas.findByText(/join\/9k2mx7qd4p/)).toBeInTheDocument();
	},
});

/** A member reads the same sections, less the ones only an administrator may open. */
export const AsAMember = meta.story({
	beforeEach({ msw }) {
		msw.use(...appHandlers({ role: "member" }));
	},
	render: () => <StoryApp path={settings} />,
	play: async ({ canvas }) => {
		const nav = await canvas.findByRole("navigation", { name: "Settings" }, { timeout: 10_000 });
		// Waiting on their pods waits on the answers the list is drawn from.
		await expect(await within(nav).findByRole("button", { name: "Revenue" })).toBeInTheDocument();
		await expect(within(nav).queryByRole("link", { name: "Models" })).toBeNull();
		await expect(within(nav).queryByRole("button", { name: "New pod" })).toBeNull();
	},
});

/** On a tablet: one list, you first, every section a row that opens it, and Done. */
export const TabletList = meta.story({
	globals: TABLET,
	render: () => <StoryApp path={settings} />,
	play: async ({ canvas }) => {
		const list = await canvas.findByRole(
			"navigation",
			{ name: "Settings sections" },
			{ timeout: 10_000 },
		);
		await expect(within(list).getByRole("link", { name: "Done" })).toBeInTheDocument();
		await expect(within(list).getByRole("link", { name: /General/ })).toBeInTheDocument();
	},
});

/** On a phone, settings are the You tab, which `/settings` opens. */
export const PhoneList = meta.story({
	globals: PHONE,
	render: () => <StoryApp path={settings} />,
	play: async ({ canvas }) => {
		await expect(
			await canvas.findByRole("heading", { level: 1, name: "Settings" }, { timeout: 10_000 }),
		).toBeVisible();
	},
});

/** On a phone, a section opens full screen, with the way back to the You tab's Settings. */
export const PhoneSection = meta.story({
	globals: PHONE,
	render: () => <StoryApp path={`${settings}/members`} />,
	play: async ({ canvas }) => {
		const page = await canvas.findByRole("main", {}, { timeout: 10_000 });
		await expect(await within(page).findByRole("link", { name: "Settings" })).toBeInTheDocument();
		await expect(await within(page).findByRole("heading", { name: "Members" })).toBeInTheDocument();
	},
});

/** On a tablet, settings drill down as on a phone: a pod's page full screen, with the way back to the list. */
export const TabletSection = meta.story({
	globals: TABLET,
	render: () => <StoryApp path={`${settings}/pods/revenue/bots`} />,
	play: async ({ canvas }) => {
		const page = await canvas.findByRole("main", {}, { timeout: 10_000 });
		await expect(await within(page).findByRole("link", { name: "Settings" })).toBeInTheDocument();
		await expect(await within(page).findByRole("heading", { name: "Bots" })).toBeInTheDocument();
		await expect(canvas.queryByRole("navigation", { name: "Settings" })).toBeNull();
		await expect(canvas.queryByRole("navigation", { name: "Breadcrumb" })).toBeNull();
	},
});
