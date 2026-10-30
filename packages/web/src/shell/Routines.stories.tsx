import type { ChatList, Routine, RoutineExecution } from "@sugabots/contracts";
import { testPerson } from "@sugabots/contracts/testing";
import { HttpResponse, http } from "msw";
import { expect, within } from "storybook/test";
import preview from "#storybook/preview";
import { accountManager, growthDesk, leadResearcher, revenue } from "@/shell/story-fixtures.ts";
import {
	appHandlers,
	StoryApp,
	storyChatDetails,
	storyPodChatFor,
	storyUser,
	storyWorkspace,
} from "@/story-app.tsx";

/*
 * A pod's routines, opened from the sidebar: each with the bot that runs it
 * and how it stands, beside the chosen one's own thread, where its runs post.
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
	kind: "agent" as const,
	id: growthDesk.id,
	name: growthDesk.name,
	handle: growthDesk.handle,
	color: growthDesk.color,
	face: growthDesk.face,
	shape: growthDesk.shape,
};

/** A message in the routine's thread, by its bot or by you. */
function posted(id: string, author: "bot" | "you", text: string, at: string, resultOf?: string) {
	return {
		kind: "message",
		message: {
			id: `0199a3a0-0000-7000-8000-0000000006${id}`,
			threadId: outbound.feed,
			author: author === "bot" ? bot : testPerson({ id: storyUser.id, name: storyUser.name }),
			kind: "text",
			status: "complete",
			parts: [{ type: "text", text }],
			content: text,
			createdAt: at,
			...(resultOf && {
				routineResultOf: {
					executionId: resultOf,
					threadId: resultOf,
					routineId: outbound.id,
					routineName: "Overnight outbound",
				},
			}),
		},
	};
}

function routine(
	id: string,
	agentId: string,
	name: string,
	instructions: string,
	state: Routine["state"],
): Routine {
	return {
		id,
		workspaceId: storyWorkspace.id,
		agentId,
		name,
		instructions,
		triggers: [
			{
				id: `${id.slice(0, -2)}c1`,
				kind: "cron",
				schedule: { repeat: "cron", expression: "0 6 * * *" },
				timezone: "Australia/Sydney",
				nextScheduledAt: null,
			},
		],
		state,
		results: "post_to_chat",
		chatId: null,
		createdById: null,
		createdByAgentId: null,
		createdAt: "2026-09-01T00:00:00.000Z",
		updatedAt: "2026-09-18T06:01:00.000Z",
	} as Routine;
}

const outboundRoutine = routine(
	outbound.id,
	growthDesk.id,
	"Overnight outbound",
	"Queue the overnight leads and draft replies to anyone who answered. Flag anyone asking about pricing so the account manager can follow up first thing.",
	"enabled",
);
const renewalsRoutine = routine(
	renewals.id,
	accountManager.id,
	"Renewal reminders",
	"Remind the account owners of renewals due in the next 30 days.",
	"paused",
);

const outboundFailure: RoutineExecution = {
	id: outbound.run,
	conversationId: outbound.feed,
	routineId: outbound.id,
	workspaceId: storyWorkspace.id,
	agentId: growthDesk.id,
	threadId: outbound.run,
	routineName: "Overnight outbound",
	instructions: outboundRoutine.instructions,
	trigger: {
		kind: "cron",
		scheduledAt: "2026-09-18T06:00:00.000Z",
		acceptedAt: "2026-09-18T06:00:00.000Z",
	},
	acceptedAt: "2026-09-18T06:00:00.000Z",
	startedAt: "2026-09-18T06:00:00.000Z",
	finishedAt: "2026-09-18T06:00:12.000Z",
	state: "failed",
	error: "Gmail refused the connection: the token has expired.",
};

const chatList: ChatList = {
	chats: [{ conversation: storyPodChatFor(revenue), unreadMessages: 0 }],
	channels: [],
	threads: [],
	routines: [
		{
			routine: { id: outbound.id, name: "Overnight outbound", state: "enabled", failed: true },
			agent: growthDesk,
			conversation: {
				kind: "routine_feed",
				id: outbound.feed,
				workspaceId: storyWorkspace.id,
				podId: revenue.id,
				title: "Overnight outbound",
				createdAt: "2026-09-01T00:00:00.000Z",
				updatedAt: "2026-09-18T06:00:00.000Z",
				hostAgentId: growthDesk.id,
				routineId: outbound.id,
			},
			mentionsYou: false,
		},
		{
			routine: { id: renewals.id, name: "Renewal reminders", state: "paused", failed: false },
			agent: accountManager,
			conversation: null,
			mentionsYou: false,
		},
	],
};

function routineHandlers() {
	const feed = {
		...storyChatDetails(growthDesk),
		thread: {
			...storyChatDetails(growthDesk).thread,
			id: outbound.feed,
			conversationId: outbound.feed,
			type: "routine_feed" as const,
			title: "Overnight outbound",
		},
		routine: {
			id: outbound.id,
			agentId: growthDesk.id,
			state: "enabled" as const,
			failed: true,
			pausedAfterFailures: false,
		},
	};
	return [
		http.get(`${API}/workspaces/:workspace/chats`, () => HttpResponse.json(chatList)),
		http.get(`${API}/workspaces/:workspace/routines`, () =>
			HttpResponse.json({
				items: [
					{
						routine: outboundRoutine,
						agent: growthDesk,
						pod: { id: revenue.id, slug: revenue.slug },
					},
					{
						routine: renewalsRoutine,
						agent: accountManager,
						pod: { id: revenue.id, slug: revenue.slug },
					},
				],
			}),
		),
		http.get(`${API}/agents/:agentId/routines`, ({ params }) =>
			HttpResponse.json(
				[outboundRoutine, renewalsRoutine].filter((one) => one.agentId === params.agentId),
			),
		),
		http.get(`${API}/agents/:agentId/routines/:routineId/executions`, ({ params }) =>
			HttpResponse.json({
				items: params.routineId === outbound.id ? [outboundFailure] : [],
				nextCursor: null,
			}),
		),
		http.get(`${API}/threads/${outbound.feed}`, () => HttpResponse.json(feed)),
		http.get(`${API}/conversations/${outbound.feed}/messages`, () =>
			HttpResponse.json({
				items: [
					{
						kind: "routine",
						id: outbound.quiet,
						threadId: outbound.quiet,
						routineName: "Overnight outbound",
						triggerKind: "cron",
						state: "completed",
						error: null,
						report: "Queued 38 leads. Nobody replied overnight.",
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
						kind: "routine",
						id: outbound.run,
						threadId: outbound.run,
						routineName: "Overnight outbound",
						triggerKind: "cron",
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
	title: "Views/Routines page",
	tags: ["ai-generated"],
	parameters: { layout: "fullscreen" },
	beforeEach({ msw }) {
		msw.use(...routineHandlers());
	},
	render: () => (
		<StoryApp path={`/${storyWorkspace.slug}/pods/${revenue.slug}/routines/${outbound.id}`} />
	),
});

/**
 * A routine chosen: its bot's routines down the left, under the bot's name,
 * this one's latest run failed, and beside them its thread, run by run: one that
 * said what it did, one whose result was talked over, then one that failed.
 * Beside the thread, the routine, set up in place: its switch, its
 * instructions, its triggers, where its result goes, and Run now.
 */
export const Default = meta.story({
	play: async ({ canvas, userEvent }) => {
		const list = await canvas.findByRole("region", { name: "Routines" }, { timeout: 10_000 });
		const chosen = await within(list).findByRole("link", { name: /^Overnight outbound/ });
		await expect(chosen).toHaveAttribute("aria-current", "page");
		await expect(await within(chosen).findByText("Failed")).toBeVisible();
		// Only its bot's routines: another bot's are on that bot's page.
		await expect(within(list).queryByRole("link", { name: /^Renewal reminders/ })).toBeNull();
		await expect(
			within(list).getByRole("heading", { name: "Growth Desk's routines" }),
		).toBeVisible();
		await userEvent.click(await canvas.findByRole("button", { name: "Details" }));
		await expect(
			await canvas.findByRole("button", { name: "Run now" }, { timeout: 10_000 }),
		).toBeVisible();
		const log = await canvas.findByRole("log", { name: "Chat messages" });
		const quiet = await within(log).findByRole("article", { name: /: Passed$/ });
		await expect(quiet).toHaveTextContent("Queued 38 leads. Nobody replied overnight.");
		await expect(quiet).not.toHaveTextContent("Passed");
		await expect(within(log).getByRole("article", { name: /: Failed$/ })).toHaveTextContent(
			"Gmail refused the connection",
		);
		await expect(canvas.getByRole("switch", { name: "Routine on" })).toBeChecked();
		const revenuePod = canvas.getByRole("group", { name: "Revenue" });
		// Its bot's Routines, in the sidebar, is the row open.
		await expect(within(revenuePod).getByRole("link", { name: /^Routines/ })).toHaveAttribute(
			"aria-current",
			"page",
		);
	},
});

/** The routine's instructions, opened from the panel to change them in a dialog with room to write. */
export const EditingInstructions = meta.story({
	play: async ({ canvas, userEvent }) => {
		await userEvent.click(
			await canvas.findByRole("button", { name: "Details" }, { timeout: 10_000 }),
		);
		await userEvent.click(await canvas.findByRole("button", { name: "Edit instructions" }));
		const dialog = await within(document.body).findByRole("dialog", { name: "Instructions" });
		const field = within(dialog).getByRole("textbox", { name: "Instructions" });
		await expect(field).toHaveValue(outboundRoutine.instructions);
		// Nothing to save until the instructions change.
		await expect(within(dialog).getByRole("button", { name: "Save" })).toBeDisabled();
		await userEvent.type(field, " Skip weekends.");
		await expect(within(dialog).getByRole("button", { name: "Save" })).toBeEnabled();
	},
});

/** Add trigger, under the routine's schedule in the panel, starts by choosing the kind. */
export const AddingTrigger = meta.story({
	play: async ({ canvas, userEvent }) => {
		await userEvent.click(
			await canvas.findByRole("button", { name: "Details" }, { timeout: 10_000 }),
		);
		const triggers = await canvas.findByRole("region", { name: "Triggers" });
		await expect(within(triggers).getByRole("button", { name: /^Schedule/ })).toBeVisible();
		await userEvent.click(within(triggers).getByRole("button", { name: "Add trigger" }));
		const dialog = await within(document.body).findByRole("dialog", { name: "Add a trigger" });
		await expect(within(dialog).getByRole("button", { name: /^Webhook/ })).toBeVisible();
	},
});

/** On a phone the list is the page, until a routine is chosen. */
export const Phone = meta.story({
	globals: { viewport: { value: "iphone12", isRotated: false } },
	render: () => <StoryApp path={`/${storyWorkspace.slug}/pods/${revenue.slug}/routines`} />,
	play: async ({ canvas }) => {
		await expect(
			await canvas.findByRole("link", { name: /^Renewal reminders/ }, { timeout: 10_000 }),
		).toBeVisible();
	},
});

/** A pod with no routines: the page says how one is made, as an empty Artifacts page does. */
export const Empty = meta.story({
	beforeEach({ msw }) {
		msw.use(
			http.get(`${API}/workspaces/:workspace/chats`, () =>
				HttpResponse.json({ ...chatList, routines: [] }),
			),
		);
	},
	render: () => <StoryApp path={`/${storyWorkspace.slug}/pods/${revenue.slug}/routines`} />,
	play: async ({ canvas }) => {
		await expect(
			await canvas.findByText("No routines in Revenue yet", {}, { timeout: 10_000 }),
		).toBeVisible();
	},
});

/**
 * A bot that runs no routines yet: its list stays, with the + in its header
 * as Inbox has its controls, and the space beside it says how one is made.
 */
export const BotWithNone = meta.story({
	render: () => (
		<StoryApp
			path={`/${storyWorkspace.slug}/pods/${revenue.slug}/routines?bot=${leadResearcher.handle}`}
		/>
	),
	play: async ({ canvas }) => {
		await expect(
			await canvas.findByText(
				`No routines for ${leadResearcher.name} yet`,
				{},
				{ timeout: 10_000 },
			),
		).toBeVisible();
		await expect(
			canvas.getByRole("heading", { name: `${leadResearcher.name}'s routines` }),
		).toBeVisible();
		const list = canvas.getByRole("region", { name: "Routines" });
		await expect(within(list).getByText("No routines yet")).toBeVisible();
		await expect(
			canvas.getByText(`Ask ${leadResearcher.name} to set some up for you.`),
		).toBeVisible();
		// The + in the header, and New routine under No routines yet, both make one.
		const making = within(list).getAllByRole("link", { name: "New routine" });
		await expect(making).toHaveLength(2);
		for (const link of making) await expect(link).toBeVisible();
	},
});
