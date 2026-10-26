import type { Agent, Pod, Routine, RoutineExecution, WorkspaceRoutine } from "@sugabots/contracts";
import { routineTriggers, type TestRoutineTrigger } from "@sugabots/contracts/testing";
import { HttpResponse, http } from "msw";
// A menu is portalled to the body, so reaching it means `screen` rather than the story's canvas.
import { expect, screen, userEvent, waitFor, within } from "storybook/test";
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
	trigger: TestRoutineTrigger | readonly TestRoutineTrigger[],
	fields: Partial<Pick<Routine, "state" | "results">> = {},
): WorkspaceRoutine {
	const id = `0199a3a0-0000-7000-8000-0000000002${String(n).padStart(2, "0")}`;
	return {
		routine: {
			id,
			workspaceId: storyWorkspace.id,
			agentId: agent.id,
			name,
			instructions: `${name}: look over what changed and post a short summary.`,
			triggers: routineTriggers(id, ...[trigger].flat()),
			state: "enabled",
			results: "post_to_chat",
			chatId: null,
			createdById: null,
			createdByAgentId: null,
			createdAt: "2026-09-01T00:00:00.000Z",
			updatedAt: "2026-09-01T00:00:00.000Z",
			...fields,
		},
		agent,
		pod: { id: pod.id, slug: pod.slug },
	};
}

const cron = (expression: string): TestRoutineTrigger => ({
	kind: "cron",
	schedule: { repeat: "cron", expression },
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
		auth: { kind: "hmac", header: "X-Signature", algorithm: "sha256", encoding: "hex" },
	},
	{ results: "keep_in_run" },
);
const slackMentions = placed(
	6,
	"Slack mentions",
	accountManager,
	revenue,
	{
		kind: "webhook",
		auth: { kind: "slack" },
	},
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
const standups = placed(8, "Standup notes", chief, personal, {
	kind: "cron",
	schedule: {
		repeat: "weekly",
		every: 1,
		days: ["mon", "wed", "fri"],
		times: [9 * 60, 13 * 60, 17 * 60],
		startsOn: "2026-09-01",
	},
	timezone: "UTC",
	nextScheduledAt: null,
});
const quarterClose = placed(9, "Quarter close", accountManager, revenue, {
	kind: "cron",
	schedule: {
		repeat: "monthly",
		every: 3,
		dayOfMonth: "last",
		times: [10 * 60],
		startsOn: "2026-09-01",
	},
	timezone: "UTC",
	nextScheduledAt: null,
});
const releaseWatch = placed(
	11,
	"Release watch",
	oncall,
	engineering,
	[cron("0 9 * * 1-5"), cron("0 17 * * 5"), { kind: "webhook", auth: { kind: "bearer" } }],
	{ results: "keep_in_run" },
);
const GITHUB_CONNECTION_ID = "0199b0f2-6a4e-7c1d-9a52-3c5e1f2d4b6a";
const pullRequestReviews = placed(
	10,
	"Pull request reviews",
	oncall,
	engineering,
	{
		kind: "github",
		connectionId: GITHUB_CONNECTION_ID,
		repository: "acme/web",
		events: ["pull_request_opened", "pull_request_review"],
	},
	{ results: "keep_in_run" },
);

/** Each pod's GitHub connection, to `acme`, working on `acme/web` and `acme/infra`. */
const podRepositories = [
	http.get(`${API}/pods/:podId/connections`, ({ params }) =>
		HttpResponse.json([
			{
				id: GITHUB_CONNECTION_ID,
				workspaceId: engineering.workspaceId,
				podId: params.podId,
				name: "GitHub",
				handle: "github",
				kind: "github",
				url: "https://github.com/acme",
				auth: "header",
				signedIn: true,
				secretHeader: null,
				hasSecret: false,
				appSettingsUrl:
					"https://github.com/organizations/acme/settings/apps/sugabots-engineering-4b6a",
				status: "connected",
				toolCounts: { allow: 5, ask: 2, off: 0 },
				lastTestedAt: "2026-10-05T09:30:00.000Z",
				lastTestError: null,
				connectedBy: "Sam Rivera",
				createdAt: "2026-10-05T09:30:00.000Z",
			},
		]),
	),
	http.get(`${API}/pods/:podId/connections/:connectionId/repositories`, () =>
		HttpResponse.json({
			account: "acme",
			repositories: ["acme/web", "acme/infra"].map((repository) => ({
				repository,
				addedByName: "Sam Rivera",
				addedAt: "2026-10-05T09:30:00.000Z",
			})),
		}),
	),
];

const everyRoutine = [
	overnight,
	morningBrief,
	churnReport,
	incidentIntake,
	slackMentions,
	signups,
	standups,
	quarterClose,
];

const routinesAnswer = (items: WorkspaceRoutine[]) =>
	http.get(`${API}/workspaces/:workspace/routines`, () => HttpResponse.json({ items }));

const pageOf = (one: WorkspaceRoutine) => `${routines}/${one.routine.id}`;

type Canvas = ReturnType<typeof within>;

/** The rows of the Triggers group, once the routine's page has loaded. */
async function triggerRows(canvas: Canvas) {
	const group = await canvas.findByRole("region", { name: "Triggers" }, { timeout: 10_000 });
	return within(group).getAllByRole("button");
}

/** Opens the dialog of the routine's first trigger. */
async function openFirstTrigger(canvas: Canvas) {
	const [first] = await triggerRows(canvas);
	if (!first) throw new Error("No trigger to open");
	await userEvent.click(first);
	return screen.findByRole("dialog");
}

/** Opens Add trigger's first step, the kinds of trigger. */
async function openAddTrigger(canvas: Canvas) {
	await userEvent.click(
		await canvas.findByRole("button", { name: "Add trigger" }, { timeout: 10_000 }),
	);
	return screen.findByRole("dialog", { name: "Add a trigger" });
}

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
		await expect(await within(list).findByText("Daily at 6:00, Growth Desk")).toBeInTheDocument();
		await expect(within(list).getByText("Webhook, On-call")).toBeInTheDocument();
		await expect(within(list).getByText("Mon Wed Fri, 3 times, Chief")).toBeInTheDocument();
		await expect(
			within(list).getByText("Every 3 months at 10:00, Account Manager"),
		).toBeInTheDocument();
		await expect(within(list).getByText("Paused")).toBeInTheDocument();
		await expect(
			await canvas.findByRole("heading", { name: "Overnight outbound" }),
		).toBeInTheDocument();
	},
});

/** A scheduled routine: on, with its bot, when it runs, where its result goes, and Run now. */
export const Scheduled = meta.story({
	render: () => <StoryApp path={pageOf(overnight)} />,
	play: async ({ canvas }) => {
		await expect(
			await canvas.findByRole("heading", { name: "Overnight outbound" }, { timeout: 10_000 }),
		).toBeInTheDocument();
		await expect(canvas.getByRole("switch", { name: "On" })).toBeChecked();
		await expect(await triggerRows(canvas)).toHaveLength(2);
		await expect(canvas.getByRole("button", { name: /^Daily at 6:00/ })).toBeInTheDocument();
		await expect(canvas.getByRole("button", { name: "Run now" })).toBeInTheDocument();
		await expect(canvas.getByRole("button", { name: "More" })).toBeInTheDocument();
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
		conversationId: "0199a3a0-0000-7000-8000-000000000350",
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

/** A trigger opens in a dialog: the schedule's groups, when it runs, in which time zone, Save and Remove. */
export const Trigger = meta.story({
	render: () => <StoryApp path={pageOf(overnight)} />,
	play: async ({ canvas }) => {
		const dialog = await openFirstTrigger(canvas);
		await expect(within(dialog).getByRole("heading", { name: "Schedule" })).toBeInTheDocument();
		await expect(within(dialog).getByRole("radio", { name: "Daily" })).toBeChecked();
		await expect(
			within(dialog).getByText(/^Runs every day at 6:00, .*UTC.*\.$/),
		).toBeInTheDocument();
		await expect(within(dialog).getByRole("button", { name: "Save" })).toBeInTheDocument();
		await expect(within(dialog).getByRole("button", { name: "Remove" })).toBeInTheDocument();
	},
});

/** Several triggers: two schedules and a webhook, each a row, then Add trigger. */
export const SeveralTriggers = meta.story({
	beforeEach({ msw }) {
		msw.use(routinesAnswer([...everyRoutine, releaseWatch]));
	},
	render: () => <StoryApp path={pageOf(releaseWatch)} />,
	play: async ({ canvas }) => {
		const rows = await triggerRows(canvas);
		await expect(rows.map((row) => row.textContent)).toEqual([
			"Weekdays at 9:00Schedule",
			"Fri at 17:00Schedule",
			"WebhookWebhook",
			"Add trigger",
		]);
	},
});

/** Add trigger's first step: the kinds of trigger, Sugabots' own, then the integrations the bot's pod is connected to. */
export const AddTrigger = meta.story({
	beforeEach({ msw }) {
		msw.use(routinesAnswer([...everyRoutine, pullRequestReviews]), ...podRepositories);
	},
	render: () => <StoryApp path={pageOf(pullRequestReviews)} />,
	play: async ({ canvas, userEvent }) => {
		const step = await openAddTrigger(canvas);
		await expect(within(step).getByRole("button", { name: /^Schedule/ })).toBeVisible();
		await expect(within(step).getByRole("button", { name: /^Webhook/ })).toBeVisible();
		await expect(await within(step).findByRole("button", { name: /^GitHub/ })).toBeVisible();
		await expect(within(step).getByRole("link", { name: /^Connect more in/ })).toBeVisible();
		await userEvent.type(within(step).getByRole("searchbox", { name: "Search triggers" }), "sched");
		await expect(within(step).getByRole("button", { name: /^Schedule/ })).toBeVisible();
		await expect(within(step).queryByRole("button", { name: /^Webhook/ })).toBeNull();
	},
});

/** Several times on some days of the week: a row per time, each with a way to remove it, and room for more. */
export const SeveralTimes = meta.story({
	render: () => <StoryApp path={pageOf(standups)} />,
	play: async ({ canvas }) => {
		const dialog = within(await openFirstTrigger(canvas));
		await expect(await dialog.findByRole("radio", { name: "Weekly" })).toBeChecked();
		await expect(dialog.getAllByRole("combobox", { name: /^Time / })).toHaveLength(3);
		await expect(dialog.getAllByRole("button", { name: /^Remove / })).toHaveLength(3);
		await expect(dialog.getByRole("button", { name: "Add a time" })).toBeInTheDocument();
		await expect(
			dialog.getByText(/^Runs every week on Mon, Wed and Fri at 9:00, 13:00 and 17:00, .*UTC.*\.$/),
		).toBeInTheDocument();
	},
});

/** Every third month on its last day: Every and On the step through their values. */
export const Monthly = meta.story({
	render: () => <StoryApp path={pageOf(quarterClose)} />,
	play: async ({ canvas }) => {
		const dialog = within(await openFirstTrigger(canvas));
		await expect(await dialog.findByRole("status", { name: "Every" })).toHaveTextContent(
			"3 months",
		);
		await expect(dialog.getByRole("status", { name: "On the" })).toHaveTextContent("last day");
		await expect(
			dialog.getByText(/Runs every 3 months on the last day at 10:00/),
		).toBeInTheDocument();
	},
});

/** ⋯ beside Run now holds what else can be done: Duplicate, and Delete routine. */
export const MoreMenu = meta.story({
	render: () => <StoryApp path={pageOf(overnight)} />,
	play: async ({ canvas, userEvent }) => {
		await userEvent.click(await canvas.findByRole("button", { name: "More" }, { timeout: 10_000 }));
		const menu = await screen.findByRole("menu");
		await expect(within(menu).getByRole("menuitem", { name: "Duplicate" })).toBeInTheDocument();
		await expect(
			within(menu).getByRole("menuitem", { name: "Delete routine" }),
		).toBeInTheDocument();
	},
});

/** Paused: its switch is off, and Run now still works. */
export const Paused = meta.story({
	render: () => <StoryApp path={pageOf(churnReport)} />,
	play: async ({ canvas }) => {
		await expect(
			await canvas.findByRole("switch", { name: "On" }, { timeout: 10_000 }),
		).not.toBeChecked();
		await expect(canvas.getByRole("button", { name: "Run now" })).toBeInTheDocument();
	},
});

/** A webhook: its address, its auth, and its saved secret, hidden until Show, edited in place. */
export const Webhook = meta.story({
	render: () => <StoryApp path={pageOf(incidentIntake)} />,
	play: async ({ canvas }) => {
		const dialog = within(await openFirstTrigger(canvas));
		await expect(
			await dialog.findByText(new RegExp(`/hooks/triggers/${incidentIntake.routine.id}$`)),
		).toBeInTheDocument();
		await expect(dialog.getByRole("button", { name: "Auth: HMAC" })).toBeInTheDocument();
		await expect(dialog.getByLabelText("Header")).toHaveValue("X-Signature");
		const secret = await dialog.findByLabelText("Signing secret");
		await expect(secret).toHaveValue("whsec_Jx7KpQ2mVt9RbL4nYc8WfD3hGs6AzE1u");
		await expect(secret).toHaveAttribute("type", "password");
		await expect(dialog.getByRole("button", { name: "Copy signing secret" })).toBeInTheDocument();
	},
});

/** From Slack, only its signing secret is asked for; Escape puts the saved one back over one pasted in. */
export const SlackWebhook = meta.story({
	render: () => <StoryApp path={pageOf(slackMentions)} />,
	play: async ({ canvas, userEvent }) => {
		const dialog = within(await openFirstTrigger(canvas));
		await expect(await dialog.findByRole("button", { name: "Source: Slack" })).toBeInTheDocument();
		await expect(dialog.queryByLabelText("Header")).toBeNull();
		const secret = await dialog.findByLabelText("Signing secret");
		await userEvent.clear(secret);
		await userEvent.type(secret, "8f742231b10e8888abcd99yyyzzz85a5{Escape}");
		await expect(secret).toHaveValue("whsec_Jx7KpQ2mVt9RbL4nYc8WfD3hGs6AzE1u");
	},
});

/** The source menu: Generic, then the senders whose signing is known, each with its logo; picking one closes it. */
export const SourceMenu = meta.story({
	render: () => <StoryApp path={pageOf(incidentIntake)} />,
	play: async ({ canvas, userEvent }) => {
		const dialog = within(await openFirstTrigger(canvas));
		await userEvent.click(await dialog.findByRole("button", { name: "Source: Generic" }));
		const menu = await screen.findByRole("menu");
		for (const source of ["Generic", "GitHub", "Stripe", "Slack", "Linear"]) {
			await expect(within(menu).getByRole("menuitem", { name: source })).toBeInTheDocument();
		}
		await userEvent.click(within(menu).getByRole("menuitem", { name: "Stripe" }));
		await waitFor(() => expect(screen.queryByRole("menu")).toBeNull());
	},
});

/** Basic auth: a username to set, and a password. */
export const BasicWebhook = meta.story({
	render: () => <StoryApp path={pageOf(signups)} />,
	play: async ({ canvas }) => {
		const dialog = within(await openFirstTrigger(canvas));
		await expect(await dialog.findByLabelText("Username")).toHaveValue("sugabots");
		await expect(dialog.getByText("Password")).toBeInTheDocument();
	},
});

/** A new webhook signs by default, and starts with no secret, which the note warns lets anyone run it. */
export const NewWebhook = meta.story({
	render: () => <StoryApp path={`${routines}/new`} />,
	play: async ({ canvas, userEvent }) => {
		const step = await openAddTrigger(canvas);
		await userEvent.click(within(step).getByRole("button", { name: /^Webhook/ }));
		const dialog = within(await screen.findByRole("dialog", { name: "Webhook" }));
		await expect(dialog.getByRole("button", { name: "Auth: HMAC" })).toBeInTheDocument();
		await expect(dialog.getByLabelText("Signing secret")).toHaveValue("");
		await expect(
			dialog.getByText(/^With no secret, anyone who has the address can run it\./),
		).toBeInTheDocument();
		await expect(dialog.getByRole("button", { name: "Add trigger" })).toBeEnabled();
	},
});

/** A repository's events: which of the pod's GitHub connection's repositories, and what happening there runs it. */
export const RepositoryTrigger = meta.story({
	beforeEach({ msw }) {
		msw.use(routinesAnswer([...everyRoutine, pullRequestReviews]), ...podRepositories);
	},
	render: () => <StoryApp path={pageOf(pullRequestReviews)} />,
	play: async ({ canvas }) => {
		await expect(
			await canvas.findByRole("button", { name: /^On acme\/web/ }, { timeout: 10_000 }),
		).toBeInTheDocument();
		const dialog = within(await openFirstTrigger(canvas));
		// The pod's GitHub connection, then its repositories, load once the trigger opens.
		await expect(
			await dialog.findByRole("switch", { name: "A pull request is reviewed" }),
		).toBeChecked();
		await expect(dialog.getByRole("switch", { name: "Checks fail" })).not.toBeChecked();
	},
});

/** A new routine on a repository waits for one to be picked, from its bot's pod's. */
export const NewRepositoryRoutine = meta.story({
	beforeEach({ msw }) {
		msw.use(...podRepositories);
	},
	render: () => <StoryApp path={`${routines}/new`} />,
	play: async ({ canvas, userEvent }) => {
		const step = await openAddTrigger(canvas);
		await userEvent.click(await within(step).findByRole("button", { name: /^GitHub/ }));
		const dialog = within(await screen.findByRole("dialog", { name: "GitHub" }));
		await expect(dialog.getByRole("button", { name: "Add trigger" })).toBeDisabled();
		await userEvent.click(await dialog.findByRole("button", { name: "acme/infra" }));
		await userEvent.click(dialog.getByRole("button", { name: "Add trigger" }));
		await expect(
			await canvas.findByRole("button", { name: /^On acme\/infra/ }),
		).toBeInTheDocument();
	},
});

/**
 * A new routine starts with no triggers on the first bot, posting its result
 * to the chat, and waits for a name and instructions.
 */
export const NewRoutine = meta.story({
	render: () => <StoryApp path={`${routines}/new`} />,
	play: async ({ canvas }) => {
		await expect(
			await canvas.findByRole("heading", { name: "New routine" }, { timeout: 10_000 }),
		).toBeInTheDocument();
		await expect(canvas.getByText("Not created yet")).toBeInTheDocument();
		await expect(canvas.getByText("No triggers")).toBeInTheDocument();
		await expect(canvas.getByRole("button", { name: "Create routine" })).toBeDisabled();
		await expect(canvas.queryByRole("switch", { name: "On" })).toBeNull();
	},
});

/** A schedule added: Weekly adds a row of days, and the bot list opens in place under its pods. */
export const ChoosingDaysAndABot = meta.story({
	render: () => <StoryApp path={`${routines}/new`} />,
	play: async ({ canvas, userEvent }) => {
		const step = await openAddTrigger(canvas);
		await userEvent.click(within(step).getByRole("button", { name: /^Schedule/ }));
		const dialog = within(await screen.findByRole("dialog", { name: "Schedule" }));
		await userEvent.click(dialog.getByRole("radio", { name: "Weekly" }));
		await userEvent.click(dialog.getByRole("checkbox", { name: "Friday" }));
		await expect(dialog.getByText(/Runs every week on Mon and Fri at 9:00/)).toBeInTheDocument();
		await userEvent.click(dialog.getByRole("button", { name: "Add trigger" }));
		await expect(
			await canvas.findByRole("button", { name: /^Mon Fri at 9:00/ }),
		).toBeInTheDocument();
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
		await expect(canvas.getByRole("switch", { name: "On" })).toBeDisabled();
		await expect(canvas.queryByRole("button", { name: "Run now" })).toBeNull();
		await expect(canvas.queryByRole("button", { name: "More" })).toBeNull();
		await expect(canvas.queryByRole("button", { name: "New routine" })).toBeNull();
		await expect(canvas.getByText("Daily at 6:00")).toBeInTheDocument();
		await expect(canvas.queryByRole("button", { name: /^Daily at 6:00/ })).toBeNull();
		await expect(canvas.queryByRole("button", { name: "Add trigger" })).toBeNull();
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
