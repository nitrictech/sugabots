import type { ActivityItem, ApprovalRequest, ArtifactSummary } from "@sugabots/contracts";
import { testPerson } from "@sugabots/contracts/testing";
import { HttpResponse, http } from "msw";
import { expect, screen, within } from "storybook/test";
import preview from "#storybook/preview";
import { engineering, growthDesk, personal, revenue } from "@/shell/story-fixtures.ts";
import {
	appHandlers,
	StoryApp,
	storyChannelFor,
	storyChatActivity,
	storyChatDetails,
	storyConversationFor,
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
 * Home: every pod down the rail, and the one open beside it, with its
 * artifacts and routines, then its channels and bots.
 */
export const Home = meta.story({
	render: () => <StoryApp path={`/${storyWorkspace.slug}/pods/${revenue.slug}`} />,
	play: async ({ canvas }) => {
		const pods = await canvas.findByRole("navigation", { name: "Pods" });
		await expect(within(pods).getByRole("link", { name: revenue.name })).toHaveAttribute(
			"aria-current",
			"page",
		);
		await expect(within(pods).getByRole("link", { name: engineering.name })).toBeVisible();
		await expect(within(pods).getByRole("link", { name: "Personal, Only you" })).toBeVisible();
		await expect(canvas.getByRole("heading", { level: 1, name: revenue.name })).toBeVisible();
		await expect(canvas.queryByText("Only you can see into this pod.")).toBeNull();
		await expect(canvas.getByRole("link", { name: "Artifacts" })).toBeVisible();
		await expect(await canvas.findByRole("link", { name: "Growth Desk" })).toBeVisible();
		const tabs = canvas.getByRole("navigation", { name: "Tabs" });
		await expect(within(tabs).getByRole("link", { name: "Home" })).toHaveAttribute(
			"aria-current",
			"page",
		);
	},
});

/** Home on Personal: under its name, that only you can see into it. */
export const PersonalHome = meta.story({
	render: () => <StoryApp path={`/${storyWorkspace.slug}/pods/${personal.slug}`} />,
	play: async ({ canvas }) => {
		await expect(
			await canvas.findByRole("heading", { level: 1, name: personal.name }),
		).toBeVisible();
		await expect(canvas.getByText("Only you can see into this pod.")).toBeVisible();
	},
});

/** Inbox as a tab: titled large, with no Back, over the tabs. */
export const Inbox = meta.story({
	render: () => <StoryApp path={`/${storyWorkspace.slug}/activity`} />,
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
			http.get(`${API}/workspaces/:workspace/chats/activity`, () =>
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
	render: () => <StoryApp path={`/${storyWorkspace.slug}/activity`} />,
	play: async ({ canvas }) => {
		const tabs = await canvas.findByRole("navigation", { name: "Tabs" }, { timeout: 10_000 });
		await expect(await within(tabs).findByText("7 unread mentions")).toBeInTheDocument();
		await expect(await within(tabs).findByText("12 waiting on you")).toBeInTheDocument();
	},
});

function unreadMention(index: number): ActivityItem {
	return {
		kind: "mention",
		unread: true,
		messageId: `0199a3a0-0000-7000-8000-0000000009${String(index).padStart(2, "0")}`,
		author: testPerson({ id: "0199a3a0-0000-7000-8000-000000000011", name: "Jay Yu" }),
		preview: "@rowan-ellis can you sign off the Acme quote before 5?",
		at: new Date(Date.now() - (index + 1) * 60_000).toISOString(),
		podId: revenue.id,
		conversationId: storyChannelFor(growthDesk).id,
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
		agent: {
			kind: "agent",
			id: growthDesk.id,
			name: growthDesk.name,
			handle: growthDesk.handle,
			color: growthDesk.color,
			face: growthDesk.face,
			shape: "circle",
		},
		podId: revenue.id,
		threadId: storyChannelFor(growthDesk).id,
		conversationId: storyChannelFor(growthDesk).id,
	};
}

/** Approvals as a tab, with nothing waiting. */
export const Approvals = meta.story({
	render: () => <StoryApp path={`/${storyWorkspace.slug}/approvals`} />,
	play: async ({ canvas }) => {
		await expect(await canvas.findByText(/^Nothing waiting/)).toBeVisible();
	},
});

/**
 * The You tab's Settings: you on a card that opens your own settings, the
 * workspace's sections, then each pod, which opens a page of its own.
 */
export const You = meta.story({
	render: () => <StoryApp path={`/${storyWorkspace.slug}/you`} />,
	play: async ({ canvas }) => {
		await expect(await canvas.findByRole("heading", { level: 1, name: "Settings" })).toBeVisible();
		await expect(
			await canvas.findByRole("link", { name: new RegExp(storyUser.name) }),
		).toHaveAttribute("href", `/${storyWorkspace.slug}/settings/profile`);
		await expect(await canvas.findByRole("link", { name: "Computers" })).toHaveAttribute(
			"href",
			`/${storyWorkspace.slug}/settings/sandboxes`,
		);
		await expect(canvas.getByRole("link", { name: new RegExp(revenue.name) })).toHaveAttribute(
			"href",
			`/${storyWorkspace.slug}/you/pods/${revenue.slug}`,
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

/** A pod opened from Settings: its General, Connections, People and Bots, and Back to Settings. */
export const YouPod = meta.story({
	render: () => <StoryApp path={`/${storyWorkspace.slug}/you/pods/${revenue.slug}`} />,
	play: async ({ canvas }) => {
		await expect(await canvas.findByRole("link", { name: "Back to Settings" })).toHaveAttribute(
			"href",
			`/${storyWorkspace.slug}/you`,
		);
		await expect(canvas.getByRole("link", { name: /^Connections/ })).toHaveAttribute(
			"href",
			`/${storyWorkspace.slug}/settings/pods/${revenue.slug}/connections`,
		);
		const tabs = canvas.getByRole("navigation", { name: "Tabs" });
		await expect(within(tabs).getByRole("link", { name: /You$/ })).toHaveAttribute(
			"aria-current",
			"page",
		);
	},
});

/** A pod's Bots, opened from You: that part alone, under the pod's name. */
export const PodPart = meta.story({
	render: () => <StoryApp path={`/${storyWorkspace.slug}/settings/pods/${revenue.slug}/bots`} />,
	play: async ({ canvas }) => {
		await expect(await canvas.findByRole("heading", { level: 2, name: "Bots" })).toBeVisible();
		await expect(await canvas.findByRole("link", { name: growthDesk.name })).toBeVisible();
		await expect(canvas.queryByRole("group", { name: "Members" })).toBeNull();
	},
});

const plan: ArtifactSummary = {
	id: "0199a3a0-0000-7000-8000-0000000000f1",
	podId: revenue.id,
	kind: "document",
	title: "Q4 outreach plan",
	version: 1,
	createdBy: { agentId: growthDesk.id, name: growthDesk.name },
	createdAt: "2026-09-29T07:00:00.000Z",
	updatedAt: "2026-09-29T07:00:00.000Z",
};

/** An artifact opened from the pod's Artifacts takes the whole screen. */
export const Artifact = meta.story({
	beforeEach({ msw }) {
		msw.use(
			http.get(`${API}/pods/:podId/artifacts`, () => HttpResponse.json([plan])),
			http.get(`${API}/pods/:podId/artifacts/:artifactId`, () =>
				HttpResponse.json({
					...plan,
					content: "# Q4 outreach plan\n\nBook 40 discovery calls with mid-market accounts.",
					shownVersion: { number: 1, author: plan.createdBy, createdAt: plan.createdAt },
				}),
			),
			http.get(`${API}/pods/:podId/artifacts/:artifactId/versions`, () =>
				HttpResponse.json([{ number: 1, author: plan.createdBy, createdAt: plan.createdAt }]),
			),
		);
	},
	render: () => (
		<StoryApp path={`/${storyWorkspace.slug}/pods/${revenue.slug}/artifacts/${plan.id}`} />
	),
	play: async ({ canvas }) => {
		const artifact = await canvas.findByRole("region", { name: "Artifact" });
		await expect(
			await within(artifact).findByText("Book 40 discovery calls with mid-market accounts."),
		).toBeVisible();
		await expect(artifact.getBoundingClientRect().width).toBeGreaterThan(300);
	},
});

/**
 * A bot's channel, opened from Home: Back and the bot's face float over the
 * chat, and the tabs stay, with Home marked, until the composer is typed in.
 */
export const Opened = meta.story({
	render: () => (
		<StoryApp path={`/${storyWorkspace.slug}/pods/${revenue.slug}/agents/growth-desk`} />
	),
	play: async ({ canvas, userEvent }) => {
		const composer = await canvas.findByRole("textbox");
		await expect(canvas.getByRole("link", { name: `Back to ${revenue.name}` })).toBeVisible();
		const tabs = canvas.getByRole("navigation", { name: "Tabs" });
		await expect(within(tabs).getByRole("link", { name: "Home" })).toHaveAttribute(
			"aria-current",
			"page",
		);
		await userEvent.click(composer);
		await expect(canvas.queryByRole("navigation", { name: "Tabs" })).toBeNull();
	},
});

/** A pod's Artifacts, whose Back returns to that pod's Home, not the workspace's first. */
export const Artifacts = meta.story({
	beforeEach({ msw }) {
		msw.use(http.get(`${API}/pods/:podId/artifacts`, () => HttpResponse.json([])));
	},
	render: () => <StoryApp path={`/${storyWorkspace.slug}/pods/${engineering.slug}/artifacts`} />,
	play: async ({ canvas }) => {
		await expect(
			await canvas.findByRole("link", { name: `Back to ${engineering.name}` }),
		).toHaveAttribute("href", `/${storyWorkspace.slug}/pods/${engineering.slug}`);
	},
});

const longThread = storyConversationFor(growthDesk);
const LONG_TITLE = "Bot setup and purpose definition for the quarter";

/**
 * A thread with a bot: its name heads its messages, and over them a pill with
 * its name, shortened to fit, and the bot it is in, as every thread's pill is,
 * between Back and the ⋯, which holds the computer and Mark done.
 */
export const Thread = meta.story({
	beforeEach({ msw }) {
		const details = storyChatDetails(growthDesk);
		msw.use(
			http.get(`${API}/threads/${longThread.id}`, () =>
				HttpResponse.json({
					...details,
					thread: {
						...details.thread,
						id: longThread.id,
						conversationId: longThread.id,
						type: "conversation",
						title: LONG_TITLE,
					},
				}),
			),
			http.get(`${API}/threads/${longThread.id}/activity`, () =>
				HttpResponse.json(storyChatActivity(growthDesk)),
			),
		);
	},
	render: () => (
		<StoryApp path={`/${storyWorkspace.slug}/pods/${revenue.slug}/threads/${longThread.id}`} />
	),
	play: async ({ canvas, userEvent }) => {
		const more = await canvas.findByRole("button", { name: "More for this thread" });
		await expect(canvas.queryByRole("button", { name: "Mark done" })).toBeNull();
		// Back returns to the bot's chat the thread is with, not the pod's Home.
		await expect(canvas.getByRole("link", { name: `Back to ${growthDesk.name}` })).toHaveAttribute(
			"href",
			`/${storyWorkspace.slug}/pods/${revenue.slug}/agents/${growthDesk.handle}`,
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

/** The pod's channel, with a # in place of a bot's face. */
export const Channel = meta.story({
	render: () => <StoryApp path={`/${storyWorkspace.slug}/pods/${revenue.slug}/chat`} />,
	play: async ({ canvas }) => {
		await expect(
			await canvas.findByRole("heading", { level: 1, name: "General" }),
		).toBeInTheDocument();
	},
});

/** A bot's computer, from its chat: a sheet from the foot of the screen, here saying why there is none. */
export const Computer = meta.story({
	render: () => (
		<StoryApp path={`/${storyWorkspace.slug}/pods/${revenue.slug}/agents/growth-desk`} />
	),
	// Opened, for a look at the sheet; what it says waits on the workspace's computers, which vary.
	play: async ({ canvas, userEvent }) => {
		await userEvent.click(await canvas.findByRole("button", { name: "Computer" }));
	},
});
