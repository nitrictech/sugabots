import type { Agent, Pod, Routine, RoutineExecution, WorkspaceRoutine } from "@sugabots/contracts";
import { HttpResponse, http } from "msw";
import { expect, within } from "storybook/test";
import preview from "#storybook/preview";
import {
	accountManager,
	chief,
	engineering,
	growthDesk,
	linearHandler,
	oncall,
	personal,
	revenue,
} from "@/shell/story-fixtures.ts";
import { appHandlers, StoryApp, storyPods, storyUser, storyWorkspace } from "../story-app.tsx";

/*
 * Routines in settings: every routine beside the open one, or the one being
 * made. On a phone the open routine covers the list, with the way back to it.
 */

const API = import.meta.env.VITE_API_URL as string;
const routines = `/${storyWorkspace.slug}/settings/routines`;
const PHONE = { viewport: { value: "iphone12", isRotated: false } };

function placed(
	n: number,
	name: string,
	agent: Agent,
	pod: Pod,
	trigger: Routine["trigger"],
	fields: Partial<Pick<Routine, "state" | "results">> = {},
): WorkspaceRoutine {
	return {
		routine: {
			id: `0199a3a0-0000-7000-8000-0000000002${String(n).padStart(2, "0")}`,
			workspaceId: storyWorkspace.id,
			agentId: agent.id,
			name,
			instructions: `${name}: look over what changed and post a short summary.`,
			trigger,
			state: "enabled",
			results: "post_to_chat",
			createdById: null,
			createdAt: "2026-09-01T00:00:00.000Z",
			updatedAt: "2026-09-01T00:00:00.000Z",
			...fields,
		},
		agent,
		pod: { id: pod.id, slug: pod.slug },
	};
}

const cron = (expression: string): Routine["trigger"] => ({
	kind: "cron",
	expression,
	timezone: "UTC",
	nextScheduledAt: null,
});

const overnight = placed(1, "Overnight outbound", growthDesk, revenue, cron("0 6 * * *"));
const morningBrief = placed(2, "Morning brief", chief, personal, cron("0 8 * * 1-5"));
const churnReport = placed(
	3,
	"Weekly churn report",
	accountManager,
	revenue,
	cron("0 9 * * 1,3,5"),
	{
		state: "paused",
	},
);
const incidentIntake = placed(
	4,
	"Incident intake",
	oncall,
	engineering,
	{
		kind: "webhook",
		auth: { kind: "hmac", format: "body", header: "X-Signature", algorithm: "sha256" },
	},
	{ results: "keep_in_run" },
);
const slackMentions = placed(
	6,
	"Slack mentions",
	accountManager,
	revenue,
	{ kind: "webhook", auth: { kind: "hmac", format: "slack" } },
	{ results: "keep_in_run" },
);
const signups = placed(
	7,
	"New signup triage",
	linearHandler,
	engineering,
	{ kind: "webhook", auth: { kind: "basic", username: "sugabots" } },
	{ results: "keep_in_run" },
);
const everyRoutine = [overnight, morningBrief, churnReport, incidentIntake, slackMentions, signups];

const routinesAnswer = (items: WorkspaceRoutine[]) =>
	http.get(`${API}/workspaces/:workspace/routines`, () => HttpResponse.json({ items }));

const pageOf = (one: WorkspaceRoutine) => `${routines}/${one.routine.id}`;

const meta = preview.meta({
	title: "Views/Routines",
	tags: ["ai-generated"],
	parameters: { layout: "fullscreen" },
	beforeEach({ msw }) {
		msw.use(routinesAnswer(everyRoutine), ...appHandlers());
	},
});

/** Every routine with when it runs and its bot, beside the first one. */
export const List = meta.story({
	render: () => <StoryApp path={routines} />,
	play: async ({ canvas }) => {
		const list = await canvas.findByRole(
			"navigation",
			{ name: "Workspace routines" },
			{ timeout: 10_000 },
		);
		await expect(
			await within(list).findByText("Every day at 6:00, Growth Desk"),
		).toBeInTheDocument();
		await expect(within(list).getByText("When its address is called, On-call")).toBeInTheDocument();
		await expect(within(list).getByText("Paused")).toBeInTheDocument();
		await expect(
			await canvas.findByRole("heading", { name: "Overnight outbound" }),
		).toBeInTheDocument();
	},
});

/** A scheduled routine: on, with its bot, its schedule, where its result goes, and Run now. */
export const Scheduled = meta.story({
	render: () => <StoryApp path={pageOf(overnight)} />,
	play: async ({ canvas }) => {
		await expect(
			await canvas.findByRole("heading", { name: "Overnight outbound" }, { timeout: 10_000 }),
		).toBeInTheDocument();
		await expect(canvas.getByText("Growth Desk · Revenue pod")).toBeInTheDocument();
		await expect(canvas.getByRole("switch", { name: "Runs on its own" })).toBeChecked();
		await expect(canvas.getByRole("radio", { name: "Every day" })).toBeChecked();
		await expect(canvas.getByRole("button", { name: "Run now" })).toBeInTheDocument();
		await expect(canvas.getByRole("button", { name: "Delete routine" })).toBeInTheDocument();
	},
});

/** Instructions open on a page of their own, with room to write and Save, as a bot's do. */
export const Instructions = meta.story({
	render: () => <StoryApp path={pageOf(overnight)} />,
	play: async ({ canvas, userEvent }) => {
		await userEvent.click(
			await canvas.findByRole("button", { name: /^Instructions/ }, { timeout: 10_000 }),
		);
		await expect(await canvas.findByLabelText("Instructions")).toHaveValue(
			overnight.routine.instructions,
		);
		await expect(canvas.getByRole("button", { name: "Save" })).toBeDisabled();
		await expect(canvas.getByRole("button", { name: "Overnight outbound" })).toBeInTheDocument();
	},
});

function run(
	n: number,
	fields: Pick<RoutineExecution, "trigger" | "state" | "acceptedAt"> & Partial<RoutineExecution>,
): RoutineExecution {
	return {
		id: `0199a3a0-0000-7000-8000-0000000003${n}0`,
		routineId: overnight.routine.id,
		workspaceId: storyWorkspace.id,
		agentId: growthDesk.id,
		threadId: `0199a3a0-0000-7000-8000-0000000003${n}1`,
		routineName: overnight.routine.name,
		instructions: overnight.routine.instructions,
		error: null,
		startedAt: fields.acceptedAt,
		finishedAt: null,
		...fields,
	};
}

const scheduled = (at: string) => ({ kind: "cron" as const, scheduledAt: at, acceptedAt: at });

const overnightRuns = [
	run(1, {
		trigger: {
			kind: "manual",
			requestedAt: "2026-10-07T22:10:00.000Z",
			requestedByUserId: storyUser.id,
			requestId: "0199a3a0-0000-7000-8000-0000000003ff",
		},
		acceptedAt: "2026-10-07T22:10:00.000Z",
		state: "running",
	}),
	run(2, {
		trigger: scheduled("2026-10-07T06:00:00.000Z"),
		acceptedAt: "2026-10-07T06:00:00.000Z",
		finishedAt: "2026-10-07T06:00:14.000Z",
		state: "completed",
	}),
	run(3, {
		trigger: scheduled("2026-10-06T06:00:00.000Z"),
		acceptedAt: "2026-10-06T06:00:00.000Z",
		finishedAt: "2026-10-06T06:01:02.000Z",
		state: "failed",
		error: "HubSpot timed out",
	}),
	run(4, {
		trigger: {
			kind: "webhook",
			receivedAt: "2026-10-05T06:00:00.000Z",
			idempotencyKey: null,
			payload: {},
		},
		acceptedAt: "2026-10-05T06:00:00.000Z",
		state: "cancelled",
	}),
];

/** Its latest runs: one running, one done, one failed with why, one stopped; each opens its thread. */
export const RecentRuns = meta.story({
	beforeEach({ msw }) {
		msw.use(
			routinesAnswer(everyRoutine),
			http.get(`${API}/agents/:agentId/routines/:routineId/executions`, () =>
				HttpResponse.json({ items: overnightRuns, nextCursor: null }),
			),
			...appHandlers(),
		);
	},
	render: () => <StoryApp path={pageOf(overnight)} />,
	play: async ({ canvas }) => {
		const runs = await canvas.findByRole("region", { name: "Recent runs" }, { timeout: 10_000 });
		await expect(await within(runs).findByText("Run by you")).toBeInTheDocument();
		await expect(within(runs).getByText("Running…")).toBeInTheDocument();
		await expect(within(runs).getByText("14s")).toBeInTheDocument();
		await expect(within(runs).getByText("HubSpot timed out")).toBeInTheDocument();
		await expect(within(runs).getByText("Cancelled")).toBeInTheDocument();
	},
});

/** Paused: it says it runs only when asked, and Run now still works. */
export const Paused = meta.story({
	render: () => <StoryApp path={pageOf(churnReport)} />,
	play: async ({ canvas }) => {
		await expect(
			await canvas.findByText(
				"Paused. It only runs when you press Run now.",
				{},
				{ timeout: 10_000 },
			),
		).toBeInTheDocument();
		await expect(canvas.getByRole("switch", { name: "Runs on its own" })).not.toBeChecked();
		await expect(canvas.getByRole("checkbox", { name: "Wednesday" })).toBeChecked();
	},
});

/** A webhook: its address, and its secret, which shows only in the tab that made it. */
export const Webhook = meta.story({
	render: () => <StoryApp path={pageOf(incidentIntake)} />,
	play: async ({ canvas }) => {
		await expect(
			await canvas.findByText(
				new RegExp(`/hooks/routines/${incidentIntake.routine.id}$`),
				{},
				{ timeout: 10_000 },
			),
		).toBeInTheDocument();
		await expect(canvas.getByRole("radio", { name: "HMAC" })).toBeChecked();
		await expect(canvas.getByRole("radio", { name: "Plain body" })).toBeChecked();
		await expect(canvas.getByLabelText("Header")).toHaveValue("X-Signature");
		await expect(canvas.getByText("Shown only when it's made")).toBeInTheDocument();
		await expect(canvas.getByRole("button", { name: "Make a new one" })).toBeInTheDocument();
		await expect(canvas.getByText(/X-Signature: sha256=\$SIGNATURE/)).toBeInTheDocument();
	},
});

/** Slack signs its own way: no header to set, no example to copy, and its secret pasted in. */
export const SlackWebhook = meta.story({
	render: () => <StoryApp path={pageOf(slackMentions)} />,
	play: async ({ canvas, userEvent }) => {
		await userEvent.click(
			await canvas.findByRole("button", { name: "Paste" }, { timeout: 10_000 }),
		);
		await expect(canvas.getByLabelText("Sender's")).toHaveFocus();
		await expect(canvas.queryByLabelText("Header")).toBeNull();
		await expect(canvas.queryByText("Example request")).toBeNull();
		await expect(canvas.getByText(/paste its Signing Secret here/)).toBeInTheDocument();
	},
});

/** Basic auth: a username to set, a password, and a request that sends both. */
export const BasicWebhook = meta.story({
	render: () => <StoryApp path={pageOf(signups)} />,
	play: async ({ canvas }) => {
		await expect(await canvas.findByLabelText("Username", {}, { timeout: 10_000 })).toHaveValue(
			"sugabots",
		);
		await expect(canvas.getByText("Password")).toBeInTheDocument();
		await expect(canvas.getByText(/-u "sugabots:\$PASSWORD"/)).toBeInTheDocument();
	},
});

/** A new webhook signs by default, and takes a secret its sender made, or makes one. */
export const NewWebhook = meta.story({
	render: () => <StoryApp path={`${routines}/new`} />,
	play: async ({ canvas, userEvent }) => {
		await userEvent.click(
			await canvas.findByRole("radio", { name: "Webhook" }, { timeout: 10_000 }),
		);
		await expect(canvas.getByRole("radio", { name: "HMAC" })).toBeChecked();
		await expect(canvas.getByLabelText("Secret")).toHaveAttribute(
			"placeholder",
			"Made for you, or paste the sender's",
		);
		await expect(canvas.getByText(/send the hex digest in X-Signature/)).toBeInTheDocument();
	},
});

/**
 * A new routine starts on a daily schedule at 9:00 on the first bot, posting
 * its result to the chat, and waits for a name and instructions.
 */
export const NewRoutine = meta.story({
	render: () => <StoryApp path={`${routines}/new`} />,
	play: async ({ canvas }) => {
		await expect(
			await canvas.findByRole("heading", { name: "New routine" }, { timeout: 10_000 }),
		).toBeInTheDocument();
		await expect(canvas.getByText("Not created yet")).toBeInTheDocument();
		await expect(canvas.getByRole("radio", { name: "Every day" })).toBeChecked();
		await expect(canvas.getByText("9:00")).toBeInTheDocument();
		await expect(canvas.getByRole("button", { name: "Create routine" })).toBeDisabled();
		await expect(canvas.queryByRole("switch", { name: "Runs on its own" })).toBeNull();
	},
});

/** Weekly adds a row of days, and the bot list opens in place under its pods. */
export const ChoosingDaysAndABot = meta.story({
	render: () => <StoryApp path={`${routines}/new`} />,
	play: async ({ canvas, userEvent }) => {
		await userEvent.click(
			await canvas.findByRole("radio", { name: "Weekly" }, { timeout: 10_000 }),
		);
		await userEvent.click(canvas.getByRole("checkbox", { name: "Friday" }));
		await expect(canvas.getByText(/Runs Mondays and Fridays at 9:00/)).toBeInTheDocument();
		await userEvent.click(canvas.getByRole("button", { name: /^Bot/ }));
		await expect(canvas.getByRole("heading", { name: "Engineering" })).toBeInTheDocument();
	},
});

/** Somebody who may not manage a pod's routines reads them without the controls to change them. */
export const AsAMember = meta.story({
	beforeEach({ msw }) {
		const asMember = storyPods.map((pod) => ({
			...pod,
			permissions: { ...pod.permissions, manageRoutines: false, runRoutines: false },
		}));
		msw.use(routinesAnswer(everyRoutine), ...appHandlers({ role: "member", pods: asMember }));
	},
	render: () => <StoryApp path={pageOf(overnight)} />,
	play: async ({ canvas }) => {
		await expect(
			await canvas.findByRole("heading", { name: "Overnight outbound" }, { timeout: 10_000 }),
		).toBeInTheDocument();
		await expect(canvas.getByRole("switch", { name: "Runs on its own" })).toBeDisabled();
		await expect(canvas.queryByRole("button", { name: "Run now" })).toBeNull();
		await expect(canvas.queryByRole("button", { name: "Delete routine" })).toBeNull();
		await expect(canvas.queryByRole("button", { name: "New routine" })).toBeNull();
	},
});

/** Nothing made yet: what a routine is, and New routine. */
export const Empty = meta.story({
	beforeEach({ msw }) {
		msw.use(routinesAnswer([]), ...appHandlers());
	},
	render: () => <StoryApp path={routines} />,
	play: async ({ canvas }) => {
		await expect(
			await canvas.findByText("No routines yet", {}, { timeout: 10_000 }),
		).toBeInTheDocument();
		await expect(canvas.getAllByRole("button", { name: "New routine" }).length).toBeGreaterThan(0);
	},
});

/** On a phone the list stands alone. */
export const PhoneList = meta.story({
	globals: PHONE,
	render: () => <StoryApp path={routines} />,
	play: async ({ canvas }) => {
		await expect(
			await canvas.findByRole("navigation", { name: "Workspace routines" }, { timeout: 10_000 }),
		).toBeInTheDocument();
		await expect(canvas.queryByRole("heading", { name: "Overnight outbound" })).toBeNull();
	},
});

/** On a phone the open routine covers the list, with the way back to it. */
export const PhoneRoutine = meta.story({
	globals: PHONE,
	render: () => <StoryApp path={pageOf(churnReport)} />,
	play: async ({ canvas }) => {
		await expect(
			await canvas.findByRole("link", { name: "Routines" }, { timeout: 10_000 }),
		).toBeInTheDocument();
		await expect(
			await canvas.findByRole("heading", { name: "Weekly churn report" }),
		).toBeInTheDocument();
	},
});
