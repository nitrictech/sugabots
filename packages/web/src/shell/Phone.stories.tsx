import type { WrittenFileSummary } from "@sugabots/contracts";
import { HttpResponse, http } from "msw";
import { expect, screen, within } from "storybook/test";
import preview from "#storybook/preview";
import { engineering, growthDesk, revenue } from "@/shell/story-fixtures.ts";
import {
	appHandlers,
	StoryApp,
	storyChatDetails,
	storyChatFor,
	storyPerson,
	storySecondChatFor,
	storyWorkspace,
} from "@/story-app.tsx";

/*
 * The app on a phone: Home, Approvals and You as tabs along the foot,
 * each its own page, and anything opened from them covering the tabs.
 */

const API = import.meta.env.VITE_API_URL as string;

const meta = preview.meta({
	title: "Views/Phone",
	tags: ["ai-generated"],
	parameters: { layout: "fullscreen" },
	globals: { viewport: { value: "iphone12", isRotated: false } },
	beforeEach({ msw }) {
		msw.use(
			http.get(`${API}/workspaces/:workspace/chats/approvals`, () =>
				HttpResponse.json({ waiting: [], answered: [] }),
			),
			...appHandlers(),
		);
	},
});

/**
 * Home: the projects the person is in, each opening its chats, then
 * the bots they pinned, with Home marked among the tabs.
 */
export const Home = meta.story({
	render: () => <StoryApp path={`/${storyWorkspace.slug}/home`} />,
	play: async ({ canvas }) => {
		await expect(await canvas.findByRole("heading", { level: 1, name: "Home" })).toBeVisible();
		const projects = canvas.getByRole("region", { name: "Projects" });
		await expect(await within(projects).findByRole("link", { name: revenue.name })).toBeVisible();
		await expect(within(projects).getByRole("link", { name: engineering.name })).toBeVisible();
		await expect(within(projects).getByRole("link", { name: "Browse projects" })).toBeVisible();
		const bots = canvas.getByRole("region", { name: "Bots" });
		await expect(within(bots).getByRole("link", { name: "Browse bots" })).toBeVisible();
		const tabs = canvas.getByRole("navigation", { name: "Tabs" });
		await expect(within(tabs).getByRole("link", { name: "Home" })).toHaveAttribute(
			"aria-current",
			"page",
		);
	},
});

/** Approvals as a tab: titled large, with no Back, over the tabs, and nothing waiting. */
export const Approvals = meta.story({
	render: () => <StoryApp path={`/${storyWorkspace.slug}/approvals`} />,
	play: async ({ canvas }) => {
		await expect(await canvas.findByText(/^Nothing waiting/)).toBeVisible();
		await expect(canvas.queryByRole("link", { name: "Back" })).toBeNull();
		const tabs = canvas.getByRole("navigation", { name: "Tabs" });
		await expect(within(tabs).getByRole("link", { name: /^Approvals/ })).toHaveAttribute(
			"aria-current",
			"page",
		);
	},
});

/** Waiting approvals counted on the Approvals tab, at its icon's corner, in two digits. */
export const TabCounts = meta.story({
	beforeEach({ msw }) {
		msw.use(
			http.get(`${API}/workspaces/:workspace/chats/attention`, () =>
				HttpResponse.json({ waitingApprovals: 12, unreadForYou: 7 }),
			),
		);
	},
	render: () => <StoryApp path={`/${storyWorkspace.slug}/home`} />,
	play: async ({ canvas }) => {
		const tabs = await canvas.findByRole("navigation", { name: "Tabs" }, { timeout: 10_000 });
		await expect(await within(tabs).findByText("12 waiting on you")).toBeInTheDocument();
	},
});

/** The You tab's Settings: you on a card that opens your own settings, then the workspace's sections. */
export const You = meta.story({
	render: () => <StoryApp path={`/${storyWorkspace.slug}/you`} />,
	play: async ({ canvas }) => {
		await expect(await canvas.findByRole("heading", { level: 1, name: "Settings" })).toBeVisible();
		await expect(
			await canvas.findByRole("link", { name: new RegExp(storyPerson.name) }),
		).toHaveAttribute("href", `/${storyWorkspace.slug}/settings/account`);
		await expect(await canvas.findByRole("link", { name: "Computers" })).toHaveAttribute(
			"href",
			`/${storyWorkspace.slug}/settings/computers`,
		);
		await expect(canvas.getByRole("button", { name: "Sign out" })).toBeVisible();
	},
});

/** Your account, opened from your card: your account and appearance, then Notifications. */
export const Account = meta.story({
	render: () => <StoryApp path={`/${storyWorkspace.slug}/settings/account`} />,
	play: async ({ canvas }) => {
		await expect(await canvas.findByRole("heading", { name: storyPerson.name })).toBeVisible();
		await expect(canvas.getByRole("link", { name: "Notifications" })).toHaveAttribute(
			"href",
			`/${storyWorkspace.slug}/settings/notifications`,
		);
	},
});

/** A project's Bots, a page under its settings: that part alone, under the project's name. */
export const ProjectPart = meta.story({
	render: () => (
		<StoryApp path={`/${storyWorkspace.slug}/projects/${revenue.slug}/settings/bots`} />
	),
	play: async ({ canvas }) => {
		await expect(await canvas.findByRole("heading", { level: 1, name: "Bots" })).toBeVisible();
		await expect(await canvas.findByRole("link", { name: growthDesk.name })).toBeVisible();
		await expect(canvas.queryByRole("heading", { name: "People" })).toBeNull();
	},
});

const plan: WrittenFileSummary = {
	id: "0199a3a0-0000-7000-8000-0000000000f1",
	chatId: storyChatFor(growthDesk).id,
	kind: "document",
	title: "Q4 outreach plan",
	version: 1,
	createdBy: { botId: growthDesk.id, name: growthDesk.name },
	createdAt: "2026-09-29T07:00:00.000Z",
	updatedAt: "2026-09-29T07:00:00.000Z",
};

/** A file opened from the project's Files takes the whole screen. */
export const OpenFile = meta.story({
	beforeEach({ msw }) {
		msw.use(
			http.get(`${API}/projects/:projectId/files`, () => HttpResponse.json([plan])),
			http.get(`${API}/files/:fileId`, () =>
				HttpResponse.json({
					...plan,
					content: "# Q4 outreach plan\n\nBook 40 discovery calls with mid-market accounts.",
					shownVersion: { number: 1, author: plan.createdBy, createdAt: plan.createdAt },
				}),
			),
			http.get(`${API}/files/:fileId/versions`, () =>
				HttpResponse.json([{ number: 1, author: plan.createdBy, createdAt: plan.createdAt }]),
			),
		);
	},
	render: () => (
		<StoryApp path={`/${storyWorkspace.slug}/projects/${revenue.slug}/files/${plan.id}`} />
	),
	play: async ({ canvas }) => {
		const file = await canvas.findByRole("region", { name: "File" });
		await expect(
			await within(file).findByText("Book 40 discovery calls with mid-market accounts."),
		).toBeVisible();
		await expect(file.getBoundingClientRect().width).toBeGreaterThan(300);
	},
});

/**
 * A bot's new-chat composer, opened from its page: the tabs stay, with Home
 * marked, until the composer is typed in.
 */
export const Opened = meta.story({
	render: () => <StoryApp path={`/${storyWorkspace.slug}/bots/${growthDesk.handle}/new`} />,
	play: async ({ canvas, userEvent }) => {
		const composer = await canvas.findByRole("textbox");
		const tabs = canvas.getByRole("navigation", { name: "Tabs" });
		await expect(within(tabs).getByRole("link", { name: "Home" })).toHaveAttribute(
			"aria-current",
			"page",
		);
		await userEvent.click(composer);
		await expect(canvas.queryByRole("navigation", { name: "Tabs" })).toBeNull();
	},
});

/** A project's Files, whose Back returns to that project's Home, not the workspace's first. */
export const Files = meta.story({
	beforeEach({ msw }) {
		msw.use(http.get(`${API}/projects/:projectId/files`, () => HttpResponse.json([])));
	},
	render: () => <StoryApp path={`/${storyWorkspace.slug}/projects/${engineering.slug}/files`} />,
	play: async ({ canvas }) => {
		await expect(
			await canvas.findByRole("link", { name: `Back to ${engineering.name}` }),
		).toHaveAttribute("href", `/${storyWorkspace.slug}/projects/${engineering.slug}`);
	},
});

const longChat = storySecondChatFor(growthDesk);
const LONG_TITLE = "Bot setup and purpose definition for the quarter";

/**
 * A chat with a bot: its name heads its messages, and over them a pill with
 * its name, shortened to fit, and the bot it is with, as every bot's chat's pill is,
 * between Back and the ⋯, which holds the computer and Resolve.
 */
export const BotChat = meta.story({
	beforeEach({ msw }) {
		const details = storyChatDetails(growthDesk);
		msw.use(
			http.get(`${API}/chats/${longChat.id}`, () =>
				HttpResponse.json({
					...details,
					chat: {
						...details.chat,
						id: longChat.id,
						rootChatId: longChat.id,
						kind: "project_chat",
						title: LONG_TITLE,
					},
				}),
			),
			http.get(`${API}/chats/${longChat.id}/context`, () => HttpResponse.json(null)),
		);
	},
	render: () => (
		<StoryApp path={`/${storyWorkspace.slug}/bots/${growthDesk.handle}/chats/${longChat.id}`} />
	),
	play: async ({ canvas, userEvent }) => {
		const more = await canvas.findByRole("button", { name: "More for this chat" });
		await expect(canvas.queryByRole("button", { name: "Resolve" })).toBeNull();
		// Back returns to the bot the chat is with.
		await expect(canvas.getByRole("link", { name: `Back to ${growthDesk.name}` })).toHaveAttribute(
			"href",
			`/${storyWorkspace.slug}/bots/${growthDesk.handle}`,
		);
		// The chat's name heads its messages, and the pill over them, shortened to fit.
		await expect(await canvas.findByRole("heading", { level: 2, name: LONG_TITLE })).toBeVisible();
		const pill = canvas
			.getByText(LONG_TITLE, { selector: "button[aria-hidden] span" })
			.closest("button")
			?.getBoundingClientRect();
		await expect(pill?.right).toBeLessThanOrEqual(more.getBoundingClientRect().left);
		await userEvent.click(more);
		const menu = await screen.findByRole("menu");
		await expect(within(menu).getByRole("menuitem", { name: "Resolve" })).toBeVisible();
		await expect(within(menu).getByRole("menuitem", { name: "Computer" })).toBeVisible();
	},
});

/** A project: its work to pick from, as its sidebar lists it, its Files, and + to start a chat. */
export const Project = meta.story({
	render: () => <StoryApp path={`/${storyWorkspace.slug}/projects/${revenue.slug}`} />,
	play: async ({ canvas }) => {
		await expect(
			await canvas.findByRole("heading", { level: 1, name: revenue.name }),
		).toBeInTheDocument();
		const work = await canvas.findByRole("region", { name: "Chats" });
		await expect(await within(work).findByRole("link", { name: /Planning/ })).toBeVisible();
		await expect(canvas.getByRole("link", { name: "Files" })).toBeVisible();
		await expect(canvas.getByRole("link", { name: `New chat in ${revenue.name}` })).toBeVisible();
	},
});

/** A bot, as a project is: its chats to pick from, its Files, and + to start a chat. */
export const Bot = meta.story({
	render: () => <StoryApp path={`/${storyWorkspace.slug}/bots/${growthDesk.handle}`} />,
	play: async ({ canvas }) => {
		await expect(
			await canvas.findByRole("heading", { level: 1, name: growthDesk.name }),
		).toBeInTheDocument();
		const work = await canvas.findByRole("region", { name: "Chats" });
		await expect(
			await within(work).findByRole("link", { name: new RegExp(storyChatFor(growthDesk).title) }),
		).toBeVisible();
		await expect(canvas.getByRole("link", { name: "Files" })).toBeVisible();
		await expect(
			canvas.getByRole("link", { name: `New chat with ${growthDesk.name}` }),
		).toBeVisible();
	},
});

/**
 * A bot's computer, from a chat's More menu: a sheet from the foot of the
 * screen, here saying why there is none.
 */
export const Computer = meta.story({
	render: () => (
		<StoryApp
			path={`/${storyWorkspace.slug}/bots/${growthDesk.handle}/chats/${storyChatFor(growthDesk).id}`}
		/>
	),
	// Opened, for a look at the sheet; what it says waits on the workspace's computers, which vary.
	play: async ({ canvas, userEvent }) => {
		await userEvent.click(await canvas.findByRole("button", { name: "More for this chat" }));
		await userEvent.click(await screen.findByRole("menuitem", { name: "Computer" }));
		await expect(
			await screen.findByRole("dialog", { name: `${growthDesk.name}'s computer` }),
		).toBeVisible();
	},
});
