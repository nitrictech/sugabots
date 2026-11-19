import type { ApprovalRequest, InboxItem, WrittenFileSummary } from "@sugabots/contracts";
import { testPerson } from "@sugabots/contracts/testing";
import { HttpResponse, http } from "msw";
import { expect, screen, within } from "storybook/test";
import preview from "#storybook/preview";
import { engineering, growthDesk, revenue } from "@/shell/story-fixtures.ts";
import {
	appHandlers,
	StoryApp,
	storyChatActivity,
	storyChatDetails,
	storyConversationFor,
	storyThreadFor,
	storyUser,
	storyWorkspace,
} from "@/story-app.tsx";

/*
 * The app on a phone: Home, Inbox, Approvals and You as tabs along the foot,
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
 * Home: the projects the person is in, each opening its threads, then
 * the bots they pinned, with Home marked among the tabs.
 */
export const Home = meta.story({
	render: () => <StoryApp path={`/${storyWorkspace.slug}/home`} />,
	play: async ({ canvas }) => {
		await expect(await canvas.findByRole("heading", { level: 1, name: "Home" })).toBeVisible();
		const projects = canvas.getByRole("region", { name: "Projects" });
		await expect(within(projects).getByRole("link", { name: revenue.name })).toBeVisible();
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

/** Direct messages, under Home: going to Inbox and back to Home returns to them, not to a project. */
export const DirectMessagesHome = meta.story({
	render: () => <StoryApp path={`/${storyWorkspace.slug}/dm`} />,
	play: async ({ canvas, userEvent }) => {
		const tabs = await canvas.findByRole("navigation", { name: "Tabs" });
		const home = within(tabs).getByRole("link", { name: "Home" });
		await expect(home).toHaveAttribute("aria-current", "page");
		await expect(home).toHaveAttribute("href", `/${storyWorkspace.slug}/dm`);

		await userEvent.click(within(tabs).getByRole("link", { name: /^Inbox/ }));

		await expect(within(tabs).getByRole("link", { name: "Home" })).toHaveAttribute(
			"href",
			`/${storyWorkspace.slug}/dm`,
		);
	},
});

/** Inbox as a tab: titled large, with no Back, over the tabs. */
export const Inbox = meta.story({
	render: () => <StoryApp path={`/${storyWorkspace.slug}/inbox`} />,
	play: async ({ canvas }) => {
		await expect(await canvas.findByRole("heading", { level: 1, name: "Inbox" })).toBeVisible();
		await expect(canvas.queryByRole("link", { name: "Back" })).toBeNull();
		const tabs = canvas.getByRole("navigation", { name: "Tabs" });
		await expect(within(tabs).getByRole("link", { name: /^Inbox/ })).toHaveAttribute(
			"aria-current",
			"page",
		);
	},
});

/**
 * Unread mentions and waiting approvals counted on the Inbox and Approvals
 * tabs, each at its icon's corner: one tab open beneath its count, one not,
 * and a count of two digits.
 */
export const TabCounts = meta.story({
	beforeEach({ msw }) {
		msw.use(
			http.get(`${API}/workspaces/:workspace/chats/inbox`, () =>
				HttpResponse.json({ items: Array.from({ length: 7 }, (_, index) => unreadMention(index)) }),
			),
			http.get(`${API}/workspaces/:workspace/chats/approvals`, () =>
				HttpResponse.json({
					waiting: Array.from({ length: 12 }, (_, index) => waitingApproval(index)),
					answered: [],
				}),
			),
		);
	},
	render: () => <StoryApp path={`/${storyWorkspace.slug}/inbox`} />,
	play: async ({ canvas }) => {
		const tabs = await canvas.findByRole("navigation", { name: "Tabs" }, { timeout: 10_000 });
		await expect(await within(tabs).findByText("7 unread messages for you")).toBeInTheDocument();
		await expect(await within(tabs).findByText("12 waiting on you")).toBeInTheDocument();
	},
});

function unreadMention(index: number): InboxItem {
	return {
		kind: "mention",
		unread: true,
		messageId: `0199a3a0-0000-7000-8000-0000000009${String(index).padStart(2, "0")}`,
		author: testPerson({ id: "0199a3a0-0000-7000-8000-000000000011", name: "Jay Yu" }),
		preview: "@rowan-ellis can you sign off the Acme quote before 5?",
		at: new Date(Date.now() - (index + 1) * 60_000).toISOString(),
		projectId: null,
		rootConversationId: storyThreadFor(growthDesk).id,
	};
}

function waitingApproval(index: number): ApprovalRequest {
	return {
		call: {
			type: "tool_call",
			id: `0199a3a0-0000-7000-8000-0000000010${String(index).padStart(2, "0")}`,
			tool: "stripe__send_quote",
			input: { customer: "Acme Retail" },
			output: null,
			status: "awaiting_approval",
			error: null,
			mutating: true,
			atOffset: 0,
			startedAt: new Date(Date.now() - 20 * 60_000).toISOString(),
			finishedAt: null,
			approval: { status: "pending", decidedByName: null, decidedAt: null },
		},
		bot: {
			kind: "bot",
			id: growthDesk.id,
			name: growthDesk.name,
			handle: growthDesk.handle,
			color: growthDesk.color,
			face: growthDesk.face,
			shape: "circle",
		},
		projectId: null,
		conversationId: storyThreadFor(growthDesk).id,
		rootConversationId: storyThreadFor(growthDesk).id,
	};
}

/** Approvals as a tab, with nothing waiting. */
export const Approvals = meta.story({
	render: () => <StoryApp path={`/${storyWorkspace.slug}/approvals`} />,
	play: async ({ canvas }) => {
		await expect(await canvas.findByText(/^Nothing waiting/)).toBeVisible();
	},
});

/** The You tab's Settings: you on a card that opens your own settings, then the workspace's sections. */
export const You = meta.story({
	render: () => <StoryApp path={`/${storyWorkspace.slug}/you`} />,
	play: async ({ canvas }) => {
		await expect(await canvas.findByRole("heading", { level: 1, name: "Settings" })).toBeVisible();
		await expect(
			await canvas.findByRole("link", { name: new RegExp(storyUser.name) }),
		).toHaveAttribute("href", `/${storyWorkspace.slug}/settings/profile`);
		await expect(await canvas.findByRole("link", { name: "Computers" })).toHaveAttribute(
			"href",
			`/${storyWorkspace.slug}/settings/computers`,
		);
		await expect(canvas.getByRole("button", { name: "Sign out" })).toBeVisible();
	},
});

/** Your profile, opened from your card: your account and appearance, then Notifications. */
export const Profile = meta.story({
	render: () => <StoryApp path={`/${storyWorkspace.slug}/settings/profile`} />,
	play: async ({ canvas }) => {
		await expect(await canvas.findByRole("heading", { name: storyUser.name })).toBeVisible();
		await expect(canvas.getByRole("link", { name: "Notifications" })).toHaveAttribute(
			"href",
			`/${storyWorkspace.slug}/settings/notifications`,
		);
	},
});

/** A project's Bots, opened from You: that part alone, under the project's name. */
export const ProjectPart = meta.story({
	render: () => (
		<StoryApp path={`/${storyWorkspace.slug}/settings/projects/${revenue.slug}/bots`} />
	),
	play: async ({ canvas }) => {
		await expect(await canvas.findByRole("heading", { level: 2, name: "Bots" })).toBeVisible();
		await expect(await canvas.findByRole("link", { name: growthDesk.name })).toBeVisible();
		await expect(canvas.queryByRole("group", { name: "Members" })).toBeNull();
	},
});

const plan: WrittenFileSummary = {
	id: "0199a3a0-0000-7000-8000-0000000000f1",
	conversationId: storyThreadFor(growthDesk).id,
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
 * A bot's chat, opened from Home: the tabs stay, with Home marked, until the
 * composer is typed in.
 */
export const Opened = meta.story({
	render: () => <StoryApp path={`/${storyWorkspace.slug}/bots/growth-desk`} />,
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

const longThread = storyConversationFor(growthDesk);
const LONG_TITLE = "Bot setup and purpose definition for the quarter";

/**
 * A thread with a bot: its name heads its messages, and over them a pill with
 * its name, shortened to fit, and the bot it is with, as every bot's thread's pill is,
 * between Back and the ⋯, which holds the computer and Mark done.
 */
export const BotThread = meta.story({
	beforeEach({ msw }) {
		const details = storyChatDetails(growthDesk);
		msw.use(
			http.get(`${API}/conversations/${longThread.id}`, () =>
				HttpResponse.json({
					...details,
					conversation: {
						...details.conversation,
						id: longThread.id,
						rootConversationId: longThread.id,
						kind: "project_thread",
						title: LONG_TITLE,
					},
				}),
			),
			http.get(`${API}/conversations/${longThread.id}/activity`, () =>
				HttpResponse.json(storyChatActivity(growthDesk)),
			),
		);
	},
	render: () => (
		<StoryApp path={`/${storyWorkspace.slug}/bots/${growthDesk.handle}/threads/${longThread.id}`} />
	),
	play: async ({ canvas, userEvent }) => {
		const more = await canvas.findByRole("button", { name: "More for this thread" });
		await expect(canvas.queryByRole("button", { name: "Mark done" })).toBeNull();
		// Back returns to the bot the thread is with.
		await expect(canvas.getByRole("link", { name: `Back to ${growthDesk.name}` })).toHaveAttribute(
			"href",
			`/${storyWorkspace.slug}/bots/${growthDesk.handle}`,
		);
		// The thread's name heads its messages, and the pill over them, shortened to fit.
		await expect(await canvas.findByRole("heading", { level: 2, name: LONG_TITLE })).toBeVisible();
		const pill = canvas
			.getByText(LONG_TITLE, { selector: "button[aria-hidden] span" })
			.closest("button")
			?.getBoundingClientRect();
		await expect(pill?.right).toBeLessThanOrEqual(more.getBoundingClientRect().left);
		await userEvent.click(more);
		const menu = await screen.findByRole("menu");
		await expect(within(menu).getByRole("menuitem", { name: "Mark done" })).toBeVisible();
		await expect(within(menu).getByRole("menuitem", { name: "Computer" })).toBeVisible();
	},
});

/** A project: its work to pick from, as its sidebar lists it, its Files, and + to start a thread. */
export const Project = meta.story({
	render: () => <StoryApp path={`/${storyWorkspace.slug}/projects/${revenue.slug}`} />,
	play: async ({ canvas }) => {
		await expect(
			await canvas.findByRole("heading", { level: 1, name: revenue.name }),
		).toBeInTheDocument();
		const work = await canvas.findByRole("list", { name: `${revenue.name}'s work` });
		await expect(await within(work).findByRole("link", { name: /Planning/ })).toBeVisible();
		await expect(canvas.getByRole("link", { name: "Files" })).toBeVisible();
		await expect(canvas.getByRole("link", { name: `New thread in ${revenue.name}` })).toBeVisible();
	},
});

/** A bot's computer, from its chat: a sheet from the foot of the screen, here saying why there is none. */
export const Computer = meta.story({
	render: () => <StoryApp path={`/${storyWorkspace.slug}/bots/growth-desk`} />,
	// Opened, for a look at the sheet; what it says waits on the workspace's computers, which vary.
	play: async ({ canvas, userEvent }) => {
		await userEvent.click(await canvas.findByRole("button", { name: "Computer" }));
	},
});
