import type {
	Agent,
	ChatList,
	Pod,
	Routine,
	RoutineTriggerInput,
	WorkspaceRoutine,
} from "@sugabots/contracts";
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
import {
	appHandlers,
	StoryApp,
	storyChatDetails,
	storyPods,
	storyWorkspace,
} from "../story-app.tsx";

/*
 * Making and changing routines on a pod's Routines page: one set up in the
 * panel beside its own thread, or one being made beside the list. On a phone
 * the routine covers the list, with the way back to it.
 */

const API = import.meta.env.VITE_API_URL as string;
const PHONE = { viewport: { value: "iphone12", isRotated: false } };
/** A routine being made beside Revenue's routines. */
const newInRevenue = `/${storyWorkspace.slug}/pods/${revenue.slug}/routines/new`;

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

/** The id of `one`'s own thread, where its runs post. */
const feedOf = (one: WorkspaceRoutine) =>
	`${one.routine.id.slice(0, -4)}f${one.routine.id.slice(-3)}`;

/**
 * `items` as the workspace's routines, each with its own thread beside its
 * pod's routines: the list, each bot's routines, and each thread, empty.
 */
function routinesAnswer(items: WorkspaceRoutine[]) {
	return [
		http.get(`${API}/workspaces/:workspace/routines`, () => HttpResponse.json({ items })),
		http.get(`${API}/agents/:agentId/routines`, ({ params }) =>
			HttpResponse.json(
				items.map(({ routine }) => routine).filter((routine) => routine.agentId === params.agentId),
			),
		),
		http.get(`${API}/workspaces/:workspace/chats`, ({ request }) => {
			const pod = new URL(request.url).searchParams.get("pod");
			const chatList: ChatList = {
				chats: [],
				channels: [],
				threads: [],
				routines: items
					.filter((item) => item.pod.slug === pod || item.pod.id === pod)
					.map(({ routine, agent, pod }) => ({
						routine: { id: routine.id, name: routine.name, state: routine.state, failed: false },
						agent,
						conversation: {
							kind: "routine_feed",
							id: feedOf({ routine, agent, pod }),
							workspaceId: storyWorkspace.id,
							podId: pod.id,
							title: routine.name,
							createdAt: routine.createdAt,
							updatedAt: routine.updatedAt,
							hostAgentId: agent.id,
							routineId: routine.id,
						},
						mentionsYou: false,
					})),
			};
			return HttpResponse.json(chatList);
		}),
		http.get(`${API}/threads/:threadId`, ({ params }) => {
			const one = items.find((item) => feedOf(item) === params.threadId);
			if (!one) return HttpResponse.json({ message: "No such thread" }, { status: 404 });
			const details = storyChatDetails(one.agent);
			return HttpResponse.json({
				...details,
				thread: {
					...details.thread,
					id: feedOf(one),
					conversationId: feedOf(one),
					type: "routine_feed",
					title: one.routine.name,
				},
				routine: {
					id: one.routine.id,
					agentId: one.agent.id,
					state: one.routine.state,
					failed: false,
					pausedAfterFailures: false,
				},
			});
		}),
		http.get(`${API}/conversations/:conversationId/messages`, () =>
			HttpResponse.json({ items: [], nextCursor: null }),
		),
	];
}

/** `one`'s own thread, beside its pod's routines, where the panel beside it sets the routine up. */
const pageOf = (one: WorkspaceRoutine) =>
	`/${storyWorkspace.slug}/pods/${one.pod.slug}/routines/${one.routine.id}`;

type Canvas = ReturnType<typeof within>;

/** The routine's panel, opened with Details if the page didn't open it already. */
async function openPanel(canvas: Canvas) {
	return waitFor(
		async () => {
			const existing = canvas.queryByRole("complementary", { name: "Routine" });
			if (existing) return within(existing);
			await userEvent.click(canvas.getByRole("button", { name: "Details" }));
			throw new Error("The routine panel has not opened yet");
		},
		{ timeout: 10_000 },
	);
}

/** The rows of the panel's Triggers, once the routine has loaded. */
async function triggerRows(canvas: Canvas) {
	const panel = await openPanel(canvas);
	const group = await panel.findByRole("region", { name: "Triggers" }, { timeout: 10_000 });
	return within(group).getAllByRole("button");
}

/** Opens the dialog of the routine's first trigger. */
async function openFirstTrigger(canvas: Canvas) {
	const [first] = await triggerRows(canvas);
	if (!first) throw new Error("No trigger to open");
	await userEvent.click(first);
	return screen.findByRole("dialog");
}

/** Opens Add trigger's first step, the kinds of trigger: in the panel, or on a routine being made. */
async function openAddTrigger(canvas: Canvas, inPanel = false) {
	const where = inPanel ? await openPanel(canvas) : canvas;
	await userEvent.click(
		await where.findByRole("button", { name: "Add trigger" }, { timeout: 10_000 }),
	);
	return screen.findByRole("dialog", { name: "Add a trigger" });
}

const meta = preview.meta({
	title: "Views/Routine editing",
	tags: ["ai-generated"],
	parameters: { layout: "fullscreen" },
	beforeEach({ msw }) {
		msw.use(...routinesAnswer(everyRoutine), ...appHandlers());
	},
});

/** A scheduled routine in its panel: on, when it runs, where its result goes, Run now, and ⋯. */
export const Scheduled = meta.story({
	render: () => <StoryApp path={pageOf(overnight)} />,
	play: async ({ canvas }) => {
		const panel = await openPanel(canvas);
		await expect(
			await panel.findByRole("heading", { name: "Overnight outbound" }, { timeout: 10_000 }),
		).toBeInTheDocument();
		await expect(panel.getByRole("switch", { name: "Routine on" })).toBeChecked();
		await expect(await triggerRows(canvas)).toHaveLength(2);
		await expect(
			panel.getByRole("button", { name: /^Schedule.*Daily at 6:00/ }),
		).toBeInTheDocument();
		await expect(panel.getByRole("button", { name: "Run now" })).toBeInTheDocument();
		await expect(
			panel.getByRole("button", { name: "More for Overnight outbound" }),
		).toBeInTheDocument();
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
		msw.use(...routinesAnswer([...everyRoutine, releaseWatch]));
	},
	render: () => <StoryApp path={pageOf(releaseWatch)} />,
	play: async ({ canvas }) => {
		const rows = await triggerRows(canvas);
		await expect(rows.map((row) => row.textContent)).toEqual([
			"ScheduleWeekdays at 9:00",
			"ScheduleFri at 17:00",
			"WebhookWebhook",
			"Add trigger",
		]);
	},
});

/** Add trigger's first step: the kinds of trigger, Sugabots' own, then the integrations the bot's pod is connected to. */
export const AddTrigger = meta.story({
	beforeEach({ msw }) {
		msw.use(...routinesAnswer([...everyRoutine, pullRequestReviews]), ...podRepositories);
	},
	render: () => <StoryApp path={pageOf(pullRequestReviews)} />,
	play: async ({ canvas, userEvent }) => {
		const step = await openAddTrigger(canvas, true);
		await expect(within(step).getByRole("button", { name: /^Schedule/ })).toBeVisible();
		await expect(within(step).getByRole("button", { name: /^Webhook/ })).toBeVisible();
		await expect(await within(step).findByRole("button", { name: /^GitHub/ })).toBeVisible();
		await expect(within(step).getByRole("link", { name: /^Connect another app/ })).toBeVisible();
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

/** A time's picker open: a short list below the chip that scrolls, with the times other chips hold unpickable. */
export const PickingATime = meta.story({
	render: () => <StoryApp path={pageOf(standups)} />,
	play: async ({ canvas }) => {
		const dialog = within(await openFirstTrigger(canvas));
		await userEvent.click(dialog.getByRole("combobox", { name: "Time 1" }));
		const list = await screen.findByRole("listbox");
		await expect(within(list).getByRole("option", { name: "9:00" })).toHaveAttribute(
			"aria-selected",
			"true",
		);
		await expect(within(list).getByRole("option", { name: "13:00" })).toHaveAttribute(
			"aria-disabled",
			"true",
		);
		await expect(list.scrollHeight).toBeGreaterThan(list.clientHeight);
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
		const panel = await openPanel(canvas);
		await userEvent.click(
			await panel.findByRole(
				"button",
				{ name: "More for Overnight outbound" },
				{ timeout: 10_000 },
			),
		);
		const menu = await screen.findByRole("menu");
		await expect(within(menu).getByRole("menuitem", { name: "Rename" })).toBeInTheDocument();
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
		const panel = await openPanel(canvas);
		await expect(
			await panel.findByRole("switch", { name: "Routine on" }, { timeout: 10_000 }),
		).not.toBeChecked();
		await expect(panel.getByRole("button", { name: "Run now" })).toBeInTheDocument();
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
		await expect(
			dialog.getByRole("button", { name: "Delivery ID: Automatic detection" }),
		).toBeInTheDocument();
		await expect(dialog.getByLabelText("Header")).toHaveValue("X-Signature");
		const secret = await dialog.findByLabelText("Signing secret");
		await expect(secret).toHaveValue("whsec_Jx7KpQ2mVt9RbL4nYc8WfD3hGs6AzE1u");
		await expect(secret).toHaveAttribute("type", "password");
		await expect(dialog.getByRole("button", { name: "Copy signing secret" })).toBeInTheDocument();
	},
});

/** A delivery header is saved independently of auth; clearing it lets every call run. */
export const DeliveryIdHeader = meta.story({
	beforeEach({ msw }) {
		let routine: Routine = {
			...incidentIntake.routine,
			triggers: incidentIntake.routine.triggers.map((trigger) => ({
				...trigger,
				deliveryIdHeader: "Idempotency-Key",
			})),
		};
		msw.use(
			...routinesAnswer([{ ...incidentIntake, routine }]),
			http.put(
				`${API}/agents/:agentId/routines/:routineId/triggers/:triggerId`,
				async ({ request, params }) => {
					const input = (await request.json()) as RoutineTriggerInput;
					if (input.kind !== "webhook") return HttpResponse.json({}, { status: 400 });
					routine = {
						...routine,
						triggers: routine.triggers.map((trigger) =>
							trigger.kind === "webhook" && trigger.id === params.triggerId
								? { ...trigger, ...input }
								: trigger,
						),
					};
					return HttpResponse.json({ routine, secrets: [] });
				},
			),
		);
	},
	render: () => <StoryApp path={pageOf(incidentIntake)} />,
	play: async ({ canvas, userEvent }) => {
		const dialog = within(await openFirstTrigger(canvas));
		const field = await dialog.findByLabelText("Delivery ID header");
		await expect(field).toHaveValue("Idempotency-Key");
		await userEvent.clear(field);
		await userEvent.type(field, "X-Request-Id{Enter}");
		await expect(await dialog.findByLabelText("Delivery ID header")).toHaveValue("X-Request-Id");
		await userEvent.clear(dialog.getByLabelText("Delivery ID header"));
		await userEvent.tab();
		await expect(await dialog.findByLabelText("Delivery ID header")).toHaveValue("");
		await expect(dialog.getByRole("button", { name: "Auth: HMAC" })).toBeInTheDocument();
	},
});

/** The delivery header stays usable in the compact phone trigger editor. */
export const DeliveryIdHeaderOnAPhone = meta.story({
	...DeliveryIdHeader.input,
	globals: { ...PHONE, theme: "light" },
	play: async (context) => {
		await waitFor(
			async () => {
				if (context.canvas.queryByRole("complementary", { name: "Routine" })) return;
				await userEvent.click(
					context.canvas.getByText("Incident intake", { selector: "button > span > span" }),
				);
				throw new Error("The routine panel has not opened yet");
			},
			{ timeout: 10_000 },
		);
		await DeliveryIdHeader.input.play?.(context);
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
	render: () => <StoryApp path={newInRevenue} />,
	play: async ({ canvas, userEvent }) => {
		const step = await openAddTrigger(canvas);
		await userEvent.click(within(step).getByRole("button", { name: /^Webhook/ }));
		const dialog = within(await screen.findByRole("dialog", { name: "Webhook" }));
		await expect(dialog.getByRole("button", { name: "Auth: HMAC" })).toBeInTheDocument();
		await expect(dialog.getByLabelText("Signing secret")).toHaveValue("");
		await expect(dialog.getByLabelText("Delivery ID header")).toHaveValue("Idempotency-Key");
		await expect(
			dialog.getByText(/^With no secret, anyone who has the address can run it\./),
		).toBeInTheDocument();
		await expect(dialog.getByRole("button", { name: "Add trigger" })).toBeEnabled();
	},
});

/** A repository's events: which of the pod's GitHub connection's repositories, and what happening there runs it. */
export const RepositoryTrigger = meta.story({
	beforeEach({ msw }) {
		msw.use(...routinesAnswer([...everyRoutine, pullRequestReviews]), ...podRepositories);
	},
	render: () => <StoryApp path={pageOf(pullRequestReviews)} />,
	play: async ({ canvas }) => {
		const panel = await openPanel(canvas);
		await expect(
			await panel.findByRole("button", { name: /^GitHub.*On acme\/web/ }, { timeout: 10_000 }),
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
	render: () => <StoryApp path={newInRevenue} />,
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
	render: () => <StoryApp path={newInRevenue} />,
	play: async ({ canvas }) => {
		await expect(
			await canvas.findByRole("heading", { name: "New routine" }, { timeout: 10_000 }),
		).toBeInTheDocument();
		await expect(canvas.getByText("No triggers")).toBeInTheDocument();
		await expect(canvas.getByRole("button", { name: "Create routine" })).toBeDisabled();
		await expect(canvas.queryByRole("switch", { name: "On" })).toBeNull();
	},
});

/** A schedule added: Weekly adds a row of days, and the bot list opens in place with the pod's own bots. */
export const ChoosingDaysAndABot = meta.story({
	render: () => <StoryApp path={newInRevenue} />,
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
		await userEvent.click(canvas.getByRole("button", { name: /^Bot(?!s\b)/ }));
		// Only the pod's own bots: a routine is kept beside its bot's pod.
		await expect(canvas.getByRole("heading", { name: revenue.name })).toBeInTheDocument();
		await expect(canvas.queryByRole("heading", { name: engineering.name })).toBeNull();
	},
});

/** Somebody who may not manage a pod's routines reads them without the controls to change them. */
export const AsAMember = meta.story({
	beforeEach({ msw }) {
		const asMember = storyPods.map((pod) => ({
			...pod,
			permissions: { ...pod.permissions, manageRoutines: false, runRoutines: false },
		}));
		msw.use(...routinesAnswer(everyRoutine), ...appHandlers({ role: "member", pods: asMember }));
	},
	render: () => <StoryApp path={pageOf(overnight)} />,
	play: async ({ canvas }) => {
		const panel = await openPanel(canvas);
		await expect(
			await panel.findByRole("heading", { name: "Overnight outbound" }, { timeout: 10_000 }),
		).toBeInTheDocument();
		await expect(panel.getByRole("switch", { name: "Routine on" })).toBeDisabled();
		await expect(panel.queryByRole("button", { name: "Run now" })).toBeNull();
		await expect(panel.queryByRole("button", { name: /^More for / })).toBeNull();
		await expect(canvas.queryByRole("link", { name: "New routine" })).toBeNull();
		await expect(panel.getByText("Daily at 6:00")).toBeInTheDocument();
		await expect(panel.queryByRole("button", { name: /^Schedule/ })).toBeNull();
		await expect(panel.queryByRole("button", { name: "Add trigger" })).toBeNull();
		await expect(panel.queryByRole("button", { name: "Edit instructions" })).toBeNull();
	},
});

/** On a phone a routine being made covers the list, with the way back to it. */
export const PhoneNewRoutine = meta.story({
	globals: PHONE,
	render: () => <StoryApp path={`${newInRevenue}?bot=${accountManager.handle}`} />,
	play: async ({ canvas }) => {
		await expect(
			await canvas.findByRole("link", { name: "Routines" }, { timeout: 10_000 }),
		).toBeInTheDocument();
		await expect(await canvas.findByRole("heading", { name: "New routine" })).toBeInTheDocument();
		await expect(canvas.getByRole("button", { name: "Create routine" })).toBeInTheDocument();
	},
});
