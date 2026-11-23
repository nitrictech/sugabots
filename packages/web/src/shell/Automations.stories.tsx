import type { Automation, AutomationUpdate, ProjectChatList, Run } from "@sugabots/contracts";
import { testPerson } from "@sugabots/contracts/testing";
import { HttpResponse, http } from "msw";
import { expect, waitFor, within } from "storybook/test";
import preview from "#storybook/preview";
import { growthDesk, leadResearcher, storyBots } from "@/shell/story-fixtures.ts";
import {
	appHandlers,
	chatPath,
	StoryApp,
	storyChatDetails,
	storyChatFor,
	storyPerson,
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
	eyes: growthDesk.eyes,
	shape: growthDesk.shape,
};

/** A message in the automation's feed, by its bot or by you. */
function posted(id: string, author: "bot" | "you", text: string, at: string, resultOf?: string) {
	return {
		kind: "message",
		message: {
			id: `0199a3a0-0000-7000-8000-0000000006${id}`,
			chatId: outbound.feed,
			author: author === "bot" ? bot : testPerson({ id: storyPerson.id, name: storyPerson.name }),
			kind: "text",
			status: "complete",
			parts: [{ type: "text", text }],
			content: text,
			createdAt: at,
			...(resultOf && {
				automationResultOf: {
					runId: resultOf,
					chatId: resultOf,
					automationId: outbound.id,
					automationName: "Overnight outbound",
				},
			}),
		},
	};
}

function automation(
	id: string,
	projectId: string,
	name: string,
	instructions: string,
	state: Automation["state"],
): Automation {
	return {
		id,
		workspaceId: storyWorkspace.id,
		projectId,
		name,
		instructions,
		triggers: [
			{
				id: `${id.slice(0, -2)}c1`,
				kind: "routine",
				schedule: { repeat: "cron", expression: "0 6 * * *" },
				timezone: "Australia/Sydney",
				nextScheduledAt: null,
			},
		],
		state,
		createdById: null,
		pausedAfterFailures: false,
		createdAt: "2026-09-01T00:00:00.000Z",
		updatedAt: "2026-09-18T06:01:00.000Z",
	};
}

const outboundAutomation = automation(
	outbound.id,
	growthDesk.defaultProjectId,
	"Overnight outbound",
	"Queue the overnight leads and draft replies to anyone who answered. Flag anyone asking about pricing so the account manager can follow up first thing.",
	"enabled",
);
const renewalsAutomation = automation(
	renewals.id,
	growthDesk.defaultProjectId,
	"Renewal reminders",
	"Remind the account owners of renewals due in the next 30 days.",
	"paused",
);

const outboundFailure: Run = {
	id: outbound.run,
	rootChatId: outbound.feed,
	automationId: outbound.id,
	workspaceId: storyWorkspace.id,
	botId: growthDesk.id,
	chatId: outbound.run,
	automationName: "Overnight outbound",
	instructions: outboundAutomation.instructions,
	trigger: {
		kind: "routine",
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

const chatList: ProjectChatList = {
	chats: [],
	automations: [
		{
			automation: {
				id: outbound.id,
				name: "Overnight outbound",
				state: "enabled",
				pausedAfterFailures: false,
			},
			chat: {
				kind: "automation_feed",
				id: outbound.feed,
				workspaceId: storyWorkspace.id,
				title: "Overnight outbound",
				createdAt: "2026-09-01T00:00:00.000Z",
				updatedAt: "2026-09-18T06:00:00.000Z",
				projectId: growthDesk.defaultProjectId,
				botId: growthDesk.id,
				automationId: outbound.id,
			},
			mentionsYou: false,
			status: {
				failing: true,
				latestRun: {
					id: outboundFailure.id,
					state: outboundFailure.state,
					posted: outboundFailure.posted,
					acceptedAt: outboundFailure.acceptedAt,
					error: outboundFailure.error,
				},
			},
		},
		{
			automation: {
				id: renewals.id,
				name: "Renewal reminders",
				state: "paused",
				pausedAfterFailures: false,
			},
			chat: null,
			mentionsYou: false,
			status: { failing: false, latestRun: null },
		},
	],
};

function automationHandlers() {
	const feed = {
		...storyChatDetails(growthDesk),
		chat: {
			...storyChatDetails(growthDesk).chat,
			id: outbound.feed,
			rootChatId: outbound.feed,
			kind: "automation_feed" as const,
			title: "Overnight outbound",
		},
		automation: {
			id: outbound.id,
			projectId: growthDesk.defaultProjectId,
			state: "enabled" as const,
			failed: true,
			pausedAfterFailures: false,
		},
	};
	return [
		// Both automations are Growth Desk's, so its default project lists them and every other none.
		http.get(`${API}/projects/:projectId/chats`, ({ params }) =>
			HttpResponse.json(
				params.projectId === growthDesk.defaultProjectId
					? chatList
					: { chats: [], automations: [] },
			),
		),
		http.get(`${API}/projects/:projectId/automations`, ({ params }) =>
			HttpResponse.json(
				[outboundAutomation, renewalsAutomation].filter(
					(one) => one.projectId === params.projectId,
				),
			),
		),
		http.get(`${API}/chats/${outbound.feed}`, () => HttpResponse.json(feed)),
		http.get(`${API}/chats/${outbound.feed}/messages`, () =>
			HttpResponse.json({
				items: [
					{
						kind: "run",
						id: outbound.quiet,
						chatId: outbound.quiet,
						automationName: "Overnight outbound",
						triggerKind: "routine",
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
						chatId: outbound.run,
						automationName: "Overnight outbound",
						triggerKind: "routine",
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
 * Start a run at the top, then its instructions, written straight into, and its
 * triggers. The bot's sidebar marks its Automations, one of whose last runs failed.
 */
export const Default = meta.story({
	play: async ({ canvas }) => {
		const page = await canvas.findByRole("region", { name: "Automation" });
		await expect(
			await within(page).findByRole("heading", { name: "Overnight outbound" }),
		).toBeVisible();
		await expect(within(page).getByRole("link", { name: "Automations" })).toBeVisible();
		await expect(within(page).getByRole("button", { name: "Start a run" })).toBeVisible();
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

const editedInstructions = `${outboundAutomation.instructions} Skip weekends.`;

/** The automation's instructions, written straight into on its page and saved once the box is left. */
export const EditingInstructions = meta.story({
	beforeEach({ msw }) {
		// The API as it keeps the automation: what is saved is what the automation is read as after.
		let saved = outboundAutomation;
		msw.use(
			http.patch(`${API}/projects/:projectId/automations/${outbound.id}`, async ({ request }) => {
				const update = (await request.json()) as AutomationUpdate;
				saved = { ...saved, ...update };
				return HttpResponse.json({ automation: saved, secrets: [] });
			}),
			http.get(`${API}/projects/:projectId/automations`, ({ params }) =>
				HttpResponse.json(
					params.projectId === growthDesk.defaultProjectId ? [saved, renewalsAutomation] : [],
				),
			),
		);
	},
	play: async ({ canvas, userEvent }) => {
		const field = await canvas.findByRole("textbox", { name: "Instructions" });
		await expect(field).toHaveValue(outboundAutomation.instructions);
		await userEvent.type(field, " Skip weekends.");
		await userEvent.tab();

		// Back to the list, and the automation opened again, reads what was saved.
		const page = canvas.getByRole("region", { name: "Automation" });
		await userEvent.click(within(page).getByRole("link", { name: "Automations" }));
		await userEvent.click(await canvas.findByRole("link", { name: /^Overnight outbound/ }));
		await waitFor(() =>
			expect(canvas.getByRole("textbox", { name: "Instructions" })).toHaveValue(editedInstructions),
		);
	},
});

/** Add trigger, in the section under the automation's routines, starts by choosing the kind. */
export const AddingTrigger = meta.story({
	play: async ({ canvas, userEvent }) => {
		const routines = await canvas.findByRole("region", { name: "Routines" });
		await expect(within(routines).getByRole("button", { name: /^Daily at 6:00/ })).toBeVisible();
		const triggers = canvas.getByRole("region", { name: "Triggers" });
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

/** A bot that runs no automations yet says what one is, and New automation opens the form, for someone who may. */
export const BotWithNone = meta.story({
	render: () => <StoryApp path={botWithNonePath} />,
	play: async ({ canvas, userEvent }) => {
		await expect(
			await canvas.findByText(`No automations for ${leadResearcher.name} yet`),
		).toBeVisible();
		// The header's New automation, then the empty state's under its sentence.
		const [, fromEmptyState] = canvas.getAllByRole("link", { name: "New automation" });
		await userEvent.click(fromEmptyState as HTMLElement);
		await expect(
			await canvas.findByRole("heading", { level: 1, name: "New automation" }),
		).toBeVisible();
		await expect(canvas.getByRole("button", { name: "Create automation" })).toBeVisible();
	},
});

/** Somebody who may not manage the bot's automations is sent to someone who may, as a bot makes them only for them. */
export const BotWithNoneAsAnEditor = meta.story({
	beforeEach({ msw }) {
		// A bot's automations are its default project's, so whether they may be managed is the bot's.
		const asEditor = storyBots.map((bot) => ({
			...bot,
			permissions: {
				...bot.permissions,
				resources: { ...bot.permissions.resources, manageAutomations: false },
			},
		}));
		msw.use(...appHandlers({ role: "editor", bots: asEditor }));
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
 * Beside a chat with the bot, as its computer opens: its automations, then one
 * of them in their place, its runs and all, and the Back before its name to the
 * list, with that chat in view throughout.
 */
export const BesideTheBotChat = meta.story({
	render: () => <StoryApp path={`${chatPath(growthDesk)}?automations=all`} />,
	play: async ({ canvas, userEvent }) => {
		const automations = await canvas.findByRole("region", {
			name: `${growthDesk.name}'s automations`,
		});
		await userEvent.click(
			await within(automations).findByRole("button", { name: /^Overnight outbound/ }),
		);
		// Its runs, in its automation feed beside the bot's chat.
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
		await expect(
			canvas.getByRole("heading", { name: storyChatFor(growthDesk).title, level: 1 }),
		).toBeVisible();
	},
});
