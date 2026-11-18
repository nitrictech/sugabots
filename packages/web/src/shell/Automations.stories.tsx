import type { Automation, BotTaskList, Run } from "@sugabots/contracts";
import { testPerson } from "@sugabots/contracts/testing";
import { HttpResponse, http } from "msw";
import { expect, waitFor, within } from "storybook/test";
import preview from "#storybook/preview";
import { accountManager, growthDesk, leadResearcher, revenue } from "@/shell/story-fixtures.ts";
import {
	appHandlers,
	chatPath,
	StoryApp,
	storyChannels,
	storyChatDetails,
	storyUser,
	storyWorkspace,
} from "@/story-app.tsx";

/*
 * A bot's automations, opened from the sidebar: each with the bot that runs it
 * and how it stands, beside the chosen one's feed, where its runs post.
 */

const API = import.meta.env.VITE_API_URL as string;

const outbound = {
	id: "0199a3a0-0000-7000-8000-0000000003b1",
	feed: "0199a3a0-0000-7000-8000-0000000003b2",
	run: "0199a3a0-0000-7000-8000-0000000003b3",
	quiet: "0199a3a0-0000-7000-8000-0000000003b4",
};
const renewals = { id: "0199a3a0-0000-7000-8000-0000000003b5" };

const bot = {
	kind: "bot" as const,
	id: growthDesk.id,
	name: growthDesk.name,
	handle: growthDesk.handle,
	color: growthDesk.color,
	face: growthDesk.face,
	shape: growthDesk.shape,
};

/** A message in the automation's feed, by its bot or by you. */
function posted(id: string, author: "bot" | "you", text: string, at: string, resultOf?: string) {
	return {
		kind: "message",
		message: {
			id: `0199a3a0-0000-7000-8000-0000000006${id}`,
			conversationId: outbound.feed,
			author: author === "bot" ? bot : testPerson({ id: storyUser.id, name: storyUser.name }),
			kind: "text",
			status: "complete",
			parts: [{ type: "text", text }],
			content: text,
			createdAt: at,
			...(resultOf && {
				automationResultOf: {
					runId: resultOf,
					conversationId: resultOf,
					automationId: outbound.id,
					automationName: "Overnight outbound",
				},
			}),
		},
	};
}

function automation(
	id: string,
	botId: string,
	name: string,
	instructions: string,
	state: Automation["state"],
): Automation {
	return {
		id,
		workspaceId: storyWorkspace.id,
		botId,
		name,
		instructions,
		triggers: [
			{
				id: `${id.slice(0, -2)}c1`,
				kind: "schedule",
				schedule: { repeat: "cron", expression: "0 6 * * *" },
				timezone: "Australia/Sydney",
				nextScheduledAt: null,
			},
		],
		state,
		results: "post_to_chat",
		chatId: null,
		createdById: null,
		createdByBotId: null,
		createdAt: "2026-09-01T00:00:00.000Z",
		updatedAt: "2026-09-18T06:01:00.000Z",
	} as Automation;
}

const outboundAutomation = automation(
	outbound.id,
	growthDesk.id,
	"Overnight outbound",
	"Queue the overnight leads and draft replies to anyone who answered. Flag anyone asking about pricing so the account manager can follow up first thing.",
	"enabled",
);
const renewalsAutomation = automation(
	renewals.id,
	accountManager.id,
	"Renewal reminders",
	"Remind the account owners of renewals due in the next 30 days.",
	"paused",
);

const outboundFailure: Run = {
	id: outbound.run,
	rootConversationId: outbound.feed,
	automationId: outbound.id,
	workspaceId: storyWorkspace.id,
	botId: growthDesk.id,
	conversationId: outbound.run,
	automationName: "Overnight outbound",
	instructions: outboundAutomation.instructions,
	trigger: {
		kind: "schedule",
		scheduledAt: "2026-09-18T06:00:00.000Z",
		acceptedAt: "2026-09-18T06:00:00.000Z",
	},
	acceptedAt: "2026-09-18T06:00:00.000Z",
	startedAt: "2026-09-18T06:00:00.000Z",
	finishedAt: "2026-09-18T06:00:12.000Z",
	state: "failed",
	error: "Gmail refused the connection: the token has expired.",
	posted: false,
};

const chatList: BotTaskList = {
	summary: null,
	tasks: [],
	automations: [
		{
			automation: {
				id: outbound.id,
				name: "Overnight outbound",
				state: "enabled",
				failed: true,
				pausedAfterFailures: false,
			},
			bot: growthDesk,
			conversation: {
				kind: "automation_feed",
				id: outbound.feed,
				workspaceId: storyWorkspace.id,
				title: "Overnight outbound",
				createdAt: "2026-09-01T00:00:00.000Z",
				updatedAt: "2026-09-18T06:00:00.000Z",
				botId: growthDesk.id,
				automationId: outbound.id,
			},
			mentionsYou: false,
		},
		{
			automation: {
				id: renewals.id,
				name: "Renewal reminders",
				state: "paused",
				failed: false,
				pausedAfterFailures: false,
			},
			bot: accountManager,
			conversation: null,
			mentionsYou: false,
		},
	],
};

function automationHandlers() {
	const feed = {
		...storyChatDetails(growthDesk),
		conversation: {
			...storyChatDetails(growthDesk).conversation,
			id: outbound.feed,
			rootConversationId: outbound.feed,
			kind: "automation_feed" as const,
			title: "Overnight outbound",
		},
		automation: {
			id: outbound.id,
			botId: growthDesk.id,
			state: "enabled" as const,
			failed: true,
			pausedAfterFailures: false,
		},
	};
	return [
		http.get(`${API}/bots/:botId/tasks`, () => HttpResponse.json(chatList)),
		http.get(`${API}/workspaces/:workspace/automations`, () =>
			HttpResponse.json({
				items: [
					{
						automation: outboundAutomation,
						bot: growthDesk,
						channel: { id: revenue.id, slug: revenue.slug },
					},
					{
						automation: renewalsAutomation,
						bot: accountManager,
						channel: { id: revenue.id, slug: revenue.slug },
					},
				],
			}),
		),
		http.get(`${API}/bots/:botId/automations`, ({ params }) =>
			HttpResponse.json(
				[outboundAutomation, renewalsAutomation].filter((one) => one.botId === params.botId),
			),
		),
		http.get(`${API}/bots/:botId/automations/:automationId/runs`, ({ params }) =>
			HttpResponse.json({
				items: params.automationId === outbound.id ? [outboundFailure] : [],
				nextCursor: null,
			}),
		),
		http.get(`${API}/conversations/${outbound.feed}`, () => HttpResponse.json(feed)),
		http.get(`${API}/conversations/${outbound.feed}/messages`, () =>
			HttpResponse.json({
				items: [
					{
						kind: "run",
						id: outbound.quiet,
						conversationId: outbound.quiet,
						automationName: "Overnight outbound",
						triggerKind: "schedule",
						state: "completed",
						error: null,
						report: null,
						createdAt: "2026-09-16T06:00:00.000Z",
					},
					posted(
						"01",
						"bot",
						"Queued 41 leads. Three replied overnight; drafts are in your outbox.",
						"2026-09-17T06:01:00.000Z",
						"0199a3a0-0000-7000-8000-0000000003a7",
					),
					posted(
						"02",
						"you",
						"Thanks. Hold the Acme one until Monday.",
						"2026-09-17T09:14:00.000Z",
					),
					posted("03", "bot", "Held. It goes out Monday at 9:00.", "2026-09-17T09:15:00.000Z"),
					{
						kind: "run",
						id: outbound.run,
						conversationId: outbound.run,
						automationName: "Overnight outbound",
						triggerKind: "schedule",
						state: "failed",
						error: "Gmail refused the connection: the token has expired.",
						report: null,
						createdAt: "2026-09-18T06:00:00.000Z",
					},
				],
				nextCursor: null,
			}),
		),
		...appHandlers(),
	];
}

const meta = preview.meta({
	title: "Views/Automations page",
	tags: ["ai-generated"],
	parameters: { layout: "fullscreen" },
	beforeEach({ msw }) {
		msw.use(...automationHandlers());
	},
	render: () => (
		<StoryApp
			path={`/${storyWorkspace.slug}/bots/${growthDesk.handle}/automations/${outbound.id}`}
		/>
	),
});

/**
 * An automation's own page, under "Growth Desk / Automations": its switch and
 * Run now at the top, then its instructions, written straight into, and its
 * triggers. The bot's sidebar marks its Automations, one of whose last runs failed.
 */
export const Default = meta.story({
	play: async ({ canvas }) => {
		const page = await canvas.findByRole("region", { name: "Automation" });
		await expect(
			await within(page).findByRole("heading", { name: "Overnight outbound" }),
		).toBeVisible();
		await expect(within(page).getByRole("link", { name: "Automations" })).toBeVisible();
		await expect(within(page).getByRole("button", { name: "Run now" })).toBeVisible();
		await expect(within(page).getByRole("switch", { name: "Automation on" })).toBeChecked();
		await expect(within(page).getByRole("textbox", { name: "Instructions" })).toHaveValue(
			outboundAutomation.instructions,
		);
		const sidebar = canvas.getByRole("navigation", { name: `${growthDesk.name}'s pages` });
		await expect(within(sidebar).getByRole("link", { name: /^Automations/ })).toHaveAttribute(
			"aria-current",
			"page",
		);
	},
});

/** The automation's instructions, written straight into on its page and saved once the box is left. */
export const EditingInstructions = meta.story({
	play: async ({ canvas, userEvent }) => {
		const field = await canvas.findByRole("textbox", { name: "Instructions" });
		await expect(field).toHaveValue(outboundAutomation.instructions);
		await userEvent.type(field, " Skip weekends.");
		await expect(field).toHaveValue(`${outboundAutomation.instructions} Skip weekends.`);
	},
});

/** Add trigger, under the automation's schedule, starts by choosing the kind. */
export const AddingTrigger = meta.story({
	play: async ({ canvas, userEvent }) => {
		const triggers = await canvas.findByRole("region", { name: "Triggers" });
		await expect(within(triggers).getByRole("button", { name: /^Schedule/ })).toBeVisible();
		await userEvent.click(within(triggers).getByRole("button", { name: "Add trigger" }));
		const dialog = await within(document.body).findByRole("dialog", { name: "Add a trigger" });
		await expect(within(dialog).getByRole("button", { name: /^Webhook/ })).toBeVisible();
	},
});

/** On a phone the list is the page, until an automation is chosen. */
export const Phone = meta.story({
	globals: { viewport: { value: "iphone12", isRotated: false } },
	render: () => <StoryApp path={`/${storyWorkspace.slug}/bots/${growthDesk.handle}/automations`} />,
	play: async ({ canvas }) => {
		await expect(await canvas.findByRole("link", { name: /^Renewal reminders/ })).toBeVisible();
	},
});

const botWithNonePath = `/${storyWorkspace.slug}/bots/${leadResearcher.handle}/automations`;

/** A bot that runs no automations yet goes straight to making one, for someone who may. */
export const BotWithNone = meta.story({
	render: () => <StoryApp path={botWithNonePath} />,
	play: async ({ canvas }) => {
		await expect(await canvas.findByRole("heading", { name: "New automation" })).toBeVisible();
		await expect(canvas.getByRole("button", { name: "Create automation" })).toBeVisible();
	},
});

/** Somebody who may not manage the bot's automations is sent to someone who may, as a bot makes them only for them. */
export const BotWithNoneAsAMember = meta.story({
	beforeEach({ msw }) {
		const asMember = storyChannels.map((channel) => ({
			...channel,
			permissions: { ...channel.permissions, manageAutomations: false },
		}));
		msw.use(...appHandlers({ role: "member", channels: asMember }));
	},
	render: () => <StoryApp path={botWithNonePath} />,
	play: async ({ canvas }) => {
		await expect(
			await canvas.findByText(`No automations for ${leadResearcher.name} yet`),
		).toBeVisible();
		await expect(canvas.queryByRole("link", { name: "New automation" })).toBeNull();
	},
});

/**
 * Beside the bot's chat, as its computer opens: its automations, then one of
 * them in their place, its runs and all, and the Back before its name to the list,
 * with the bot's chat in view throughout.
 */
export const BesideTheBotsChat = meta.story({
	render: () => <StoryApp path={`${chatPath(growthDesk)}?automations=all`} />,
	play: async ({ canvas, userEvent }) => {
		const automations = await canvas.findByRole("region", {
			name: `${growthDesk.name}'s automations`,
		});
		await userEvent.click(
			await within(automations).findByRole("button", { name: /^Overnight outbound/ }),
		);
		// Its runs, in its own chat beside the bot's.
		await waitFor(() =>
			expect(
				canvas
					.getAllByRole("log", { name: "Chat messages" })
					.some((log) => log.textContent?.includes("Queued 41 leads. Three replied overnight")),
			).toBe(true),
		);
		await userEvent.click(
			canvas.getByRole("button", { name: `Back to ${growthDesk.name}'s automations` }),
		);
		await expect(
			await canvas.findByRole("region", { name: `${growthDesk.name}'s automations` }),
		).toBeVisible();
		await expect(canvas.getByRole("heading", { name: growthDesk.name, level: 1 })).toBeVisible();
	},
});
