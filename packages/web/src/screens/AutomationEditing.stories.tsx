import type { Automation, AutomationTriggerInput, Bot } from "@sugabots/contracts";
import { automationTriggers, type TestAutomationTrigger } from "@sugabots/contracts/testing";
import { HttpResponse, http } from "msw";
// A menu is portalled to the body, so reaching it means `screen` rather than the story's canvas.
import { expect, screen, userEvent, waitFor, within } from "storybook/test";
import preview from "#storybook/preview";
import {
	accountManager,
	engineering,
	growthDesk,
	linearHandler,
	oncall,
	storyBots,
} from "@/shell/story-fixtures.test-support.ts";
import {
	appHandlers,
	StoryApp,
	storyChatDetails,
	storyWorkspace,
} from "../story-app.test-support.tsx";

/*
 * Making and changing automations on a bot's Automations page: one set up in the
 * panel beside its feed, or one being made beside the list. On a phone
 * the automation covers the list, with the way back to it.
 */

const API = import.meta.env.VITE_API_URL as string;
const PHONE = { viewport: { value: "iphone12", isRotated: false } };
/** An automation being made beside Growth Desk's automations. */
const newInRevenue = `/${storyWorkspace.slug}/bots/${growthDesk.handle}/automations/new`;

/** An automation in the workspace list that is a bot's own, as these stories show. */
type BotsAutomation = { automation: Automation; bot: Bot };

function placed(
	n: number,
	name: string,
	bot: Bot,
	trigger: TestAutomationTrigger | readonly TestAutomationTrigger[],
	fields: Partial<Pick<Automation, "state">> = {},
): BotsAutomation {
	const id = `0199a3a0-0000-7000-8000-0000000002${String(n).padStart(2, "0")}`;
	return {
		automation: {
			id,
			workspaceId: storyWorkspace.id,
			projectId: bot.defaultProjectId,
			name,
			instructions: `${name}: look over what changed and post a short summary.`,
			triggers: automationTriggers(id, ...[trigger].flat()),
			state: "enabled",
			createdById: null,
			pausedAfterFailures: false,
			createdAt: "2026-09-01T00:00:00.000Z",
			updatedAt: "2026-09-01T00:00:00.000Z",
			...fields,
		},
		bot,
	};
}

const scheduled = (expression: string): TestAutomationTrigger => ({
	kind: "routine",
	schedule: { repeat: "cron", expression },
	timezone: "UTC",
	nextScheduledAt: null,
});

const overnight = placed(1, "Overnight outbound", growthDesk, scheduled("0 6 * * *"));
const morningBrief = placed(2, "Morning brief", growthDesk, scheduled("0 8 * * 1-5"));
const churnReport = placed(3, "Weekly churn report", accountManager, scheduled("0 9 * * 1,3,5"), {
	state: "paused",
});
const incidentIntake = placed(4, "Incident intake", oncall, {
	kind: "webhook",
	deliveryIdHeader: null,
	auth: { kind: "hmac", header: "X-Signature", algorithm: "sha256", encoding: "hex" },
});
const slackMentions = placed(6, "Slack mentions", accountManager, {
	kind: "webhook",
	deliveryIdHeader: null,
	auth: { kind: "slack" },
});
const signups = placed(7, "New signup triage", linearHandler, {
	kind: "webhook",
	deliveryIdHeader: null,
	auth: { kind: "basic", username: "sugabots" },
});
const deployCheck = placed(19, "Deploy check", oncall, {
	kind: "webhook",
	auth: { kind: "bearer" },
});
const standups = placed(8, "Standup notes", oncall, {
	kind: "routine",
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
const quarterClose = placed(9, "Quarter close", accountManager, {
	kind: "routine",
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
const releaseWatch = placed(11, "Release watch", oncall, [
	scheduled("0 9 * * 1-5"),
	scheduled("0 17 * * 5"),
	{ kind: "webhook", deliveryIdHeader: null, auth: { kind: "bearer" } },
]);
const GITHUB_CONNECTOR_ID = "0199b0f2-6a4e-7c1d-9a52-3c5e1f2d4b6a";
const pullRequestReviews = placed(10, "Pull request reviews", oncall, {
	kind: "github",
	connectorId: GITHUB_CONNECTOR_ID,
	repository: "acme/web",
	events: ["pull_request_opened", "pull_request_review"],
});

/** Each project's GitHub app, installed on `acme`, working on `acme/web` and `acme/infra`. */
const projectRepositories = [
	http.get(`${API}/projects/:projectId/connectors`, ({ params }) =>
		HttpResponse.json([
			{
				id: GITHUB_CONNECTOR_ID,
				workspaceId: engineering.workspaceId,
				projectId: params.projectId,
				name: "GitHub",
				handle: "github",
				kind: "github",
				url: "https://github.com/acme",
				auth: "header",
				signedIn: true,
				signInExpired: false,
				secretHeader: null,
				hasSecret: false,
				appSettingsUrl:
					"https://github.com/organizations/acme/settings/apps/sugabots-engineering-4b6a",
				status: "connected",
				toolCounts: { allow: 5, ask: 2, off: 0 },
				lastTestError: null,
				connectedBy: {
					id: "0199a3a0-0000-7000-8000-0000000000c3",
					name: "Sam Rivera",
					email: "sam.rivera@example.com",
					image: null,
				},
				signedInAs: null,
				createdAt: "2026-10-05T09:30:00.000Z",
			},
		]),
	),
	http.get(`${API}/projects/:projectId/connectors/:connectorId/repositories`, () =>
		HttpResponse.json({
			account: "acme",
			repositories: ["acme/web", "acme/infra"].map((repository) => ({
				repository,
				addedByName: "Sam Rivera",
			})),
		}),
	),
];

const everyAutomation = [
	overnight,
	morningBrief,
	churnReport,
	incidentIntake,
	slackMentions,
	signups,
	standups,
	quarterClose,
];

/** The id of `one`'s feed, where its runs post. */
const feedId = (one: BotsAutomation) =>
	`${one.automation.id.slice(0, -4)}f${one.automation.id.slice(-3)}`;

/**
 * `items` as their bots' automations, each with its feed: each bot's
 * automations, and each feed, empty.
 */
function automationsAnswer(items: BotsAutomation[]) {
	return [
		http.get(`${API}/projects/:projectId/automations`, ({ params }) =>
			HttpResponse.json(
				items
					.map(({ automation }) => automation)
					.filter((automation) => automation.projectId === params.projectId),
			),
		),
		http.get(`${API}/projects/:projectId/chats`, ({ params }) =>
			HttpResponse.json({
				chats: [],
				automations: items
					.filter((item) => item.bot.defaultProjectId === params.projectId)
					.map(({ automation, bot }) => ({
						automation: {
							id: automation.id,
							name: automation.name,
							state: automation.state,
							pausedAfterFailures: false,
						},
						bot,
						chat: {
							kind: "automation_feed" as const,
							id: feedId({ automation, bot }),
							workspaceId: storyWorkspace.id,
							title: automation.name,
							createdAt: automation.createdAt,
							updatedAt: automation.updatedAt,
							hostBotId: bot.id,
							automationId: automation.id,
						},
						mentionsYou: false,
						status: { failing: false, latestRun: null },
					})),
			}),
		),
		http.get(`${API}/chats/:chatId`, ({ params }) => {
			const one = items.find((item) => feedId(item) === params.chatId);
			if (!one) return HttpResponse.json({ message: "No such chat" }, { status: 404 });
			const details = storyChatDetails(one.bot);
			return HttpResponse.json({
				...details,
				chat: {
					...details.chat,
					id: feedId(one),
					rootChatId: feedId(one),
					kind: "automation_feed",
					title: one.automation.name,
				},
				automation: {
					id: one.automation.id,
					projectId: one.automation.projectId,
					state: one.automation.state,
					failed: false,
					pausedAfterFailures: false,
				},
			});
		}),
		http.get(`${API}/chats/:chatId/messages`, () =>
			HttpResponse.json({ items: [], nextCursor: null }),
		),
	];
}

/** `one`'s feed, beside its bot's automations, where the panel beside it sets the automation up. */
const feedPath = (one: BotsAutomation) =>
	`/${storyWorkspace.slug}/bots/${one.bot.handle}/automations/${one.automation.id}`;

type Canvas = ReturnType<typeof within>;

/** The automation's own page, once it has loaded. */
async function openPanel(canvas: Canvas) {
	return within(await canvas.findByRole("region", { name: "Automation" }));
}

/** The rows of the panel's Routines or Triggers, its add row last, once the automation has loaded. */
async function sectionRows(canvas: Canvas, section: "Routines" | "Triggers") {
	const panel = await openPanel(canvas);
	const group = await panel.findByRole("region", { name: section });
	return within(group).getAllByRole("button");
}

const ADD_ROW = /^Add (routine|trigger)$/;

/** Opens the dialog of the automation's first routine, or of its first trigger when it has no routine. */
async function openFirstTrigger(canvas: Canvas) {
	const rows = [
		...(await sectionRows(canvas, "Routines")),
		...(await sectionRows(canvas, "Triggers")),
	];
	const first = rows.find((row) => !ADD_ROW.test(row.textContent ?? ""));
	if (!first) throw new Error("No routine or trigger to open");
	await userEvent.click(first);
	return screen.findByRole("dialog");
}

/** Opens Add trigger's first step, the kinds of trigger: in the panel, or on an automation being made. */
async function openAddTrigger(canvas: Canvas, inPanel = false) {
	const where = inPanel ? await openPanel(canvas) : canvas;
	await userEvent.click(await where.findByRole("button", { name: "Add trigger" }));
	return screen.findByRole("dialog", { name: "Add a trigger" });
}

const meta = preview.meta({
	title: "Views/Automation editing",
	tags: ["ai-generated"],
	parameters: { layout: "fullscreen" },
	beforeEach({ msw }) {
		msw.use(...automationsAnswer(everyAutomation), ...appHandlers());
	},
});

/** An automation with a routine in its panel: on, when it runs, where its result goes, Start a run, and ⋯. */
export const WithARoutine = meta.story({
	render: () => <StoryApp path={feedPath(overnight)} />,
	play: async ({ canvas }) => {
		const panel = await openPanel(canvas);
		await expect(
			await panel.findByRole("heading", { name: "Overnight outbound" }),
		).toBeInTheDocument();
		await expect(panel.getByRole("switch", { name: "Automation on" })).toBeChecked();
		await expect(await sectionRows(canvas, "Routines")).toHaveLength(2);
		await expect(panel.getByRole("button", { name: /^Daily at 6:00/ })).toBeInTheDocument();
		await expect(panel.getByRole("button", { name: "Start a run" })).toBeInTheDocument();
		await expect(
			panel.getByRole("button", { name: "More for Overnight outbound" }),
		).toBeInTheDocument();
	},
});

/** A routine opens in a dialog: when it runs, the note saying so in its time zone, Save and Remove. */
export const Trigger = meta.story({
	render: () => <StoryApp path={feedPath(overnight)} />,
	play: async ({ canvas }) => {
		const dialog = await openFirstTrigger(canvas);
		await expect(within(dialog).getByRole("heading", { name: "Routine" })).toBeInTheDocument();
		await expect(within(dialog).getByRole("radio", { name: "Daily" })).toBeChecked();
		await expect(
			within(dialog).getByText(/^Runs every day at 6:00, .*UTC.*\.$/),
		).toBeInTheDocument();
		await expect(within(dialog).getByRole("button", { name: "Save" })).toBeInTheDocument();
		await expect(within(dialog).getByRole("button", { name: "Remove" })).toBeInTheDocument();
	},
});

/** Two routines and a webhook: each a row of its section, under which Add routine and Add trigger. */
export const SeveralTriggers = meta.story({
	beforeEach({ msw }) {
		msw.use(...automationsAnswer([...everyAutomation, releaseWatch]));
	},
	render: () => <StoryApp path={feedPath(releaseWatch)} />,
	play: async ({ canvas }) => {
		const routines = await sectionRows(canvas, "Routines");
		await expect(routines.map((row) => row.textContent)).toEqual([
			"Weekdays at 9:00Routine",
			"Fri at 17:00Routine",
			"Add routine",
		]);
		const triggers = await sectionRows(canvas, "Triggers");
		await expect(triggers.map((row) => row.textContent)).toEqual(["WebhookWebhook", "Add trigger"]);
	},
});

/**
 * Add trigger's first step: the kinds of trigger, Sugabots' own, then the
 * connectors the bot has, found by typing. Routines are added
 * from their own section, so they are not among them.
 */
export const AddTrigger = meta.story({
	beforeEach({ msw }) {
		msw.use(...automationsAnswer([...everyAutomation, pullRequestReviews]), ...projectRepositories);
	},
	render: () => <StoryApp path={feedPath(pullRequestReviews)} />,
	play: async ({ canvas, userEvent }) => {
		const step = await openAddTrigger(canvas, true);
		await waitFor(() =>
			expect(within(step).getByRole("button", { name: /^Webhook/ })).toBeVisible(),
		);
		await expect(await within(step).findByRole("button", { name: /^GitHub/ })).toBeVisible();
		await expect(within(step).queryByRole("button", { name: /^Routine/ })).toBeNull();
		await expect(within(step).getByRole("link", { name: /^Add another connector/ })).toBeVisible();
		await userEvent.type(within(step).getByRole("searchbox", { name: "Search triggers" }), "hook");
		await expect(within(step).getByRole("button", { name: /^Webhook/ })).toBeVisible();
		await expect(within(step).queryByRole("button", { name: /^GitHub/ })).toBeNull();
	},
});

/** Several times on some days of the week: a row per time, each with a way to remove it, and room for more. */
export const SeveralTimes = meta.story({
	render: () => <StoryApp path={feedPath(standups)} />,
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
	render: () => <StoryApp path={feedPath(standups)} />,
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
	render: () => <StoryApp path={feedPath(quarterClose)} />,
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

/** ⋯ beside Start a run holds what else can be done: Duplicate, and Delete automation. */
export const MoreMenu = meta.story({
	render: () => <StoryApp path={feedPath(overnight)} />,
	play: async ({ canvas, userEvent }) => {
		const panel = await openPanel(canvas);
		await userEvent.click(
			await panel.findByRole("button", { name: "More for Overnight outbound" }),
		);
		const menu = await screen.findByRole("menu");
		await expect(within(menu).getByRole("menuitem", { name: "Rename" })).toBeInTheDocument();
		await expect(within(menu).getByRole("menuitem", { name: "Duplicate" })).toBeInTheDocument();
		await expect(
			within(menu).getByRole("menuitem", { name: "Delete automation" }),
		).toBeInTheDocument();
	},
});

/** Paused: its switch is off, and Start a run still works. */
export const Paused = meta.story({
	render: () => <StoryApp path={feedPath(churnReport)} />,
	play: async ({ canvas }) => {
		const panel = await openPanel(canvas);
		await expect(await panel.findByRole("switch", { name: "Automation on" })).not.toBeChecked();
		await expect(panel.getByRole("button", { name: "Start a run" })).toBeInTheDocument();
	},
});

/** A webhook: its address, its auth, and its saved secret, hidden until Show, edited in place. */
export const Webhook = meta.story({
	render: () => <StoryApp path={feedPath(incidentIntake)} />,
	play: async ({ canvas }) => {
		const dialog = within(await openFirstTrigger(canvas));
		await expect(
			await dialog.findByText(new RegExp(`/webhooks/triggers/${incidentIntake.automation.id}$`)),
		).toBeInTheDocument();
		await expect(dialog.getByRole("button", { name: "Auth: HMAC" })).toBeInTheDocument();
		await expect(
			dialog.getByRole("button", { name: "Delivery ID: Every call runs" }),
		).toBeInTheDocument();
		await expect(dialog.getByLabelText("Header")).toHaveValue("X-Signature");
		const secret = await dialog.findByLabelText("Signing secret");
		await expect(secret).toHaveValue("whsec_Jx7KpQ2mVt9RbL4nYc8WfD3hGs6AzE1u");
		await expect(secret).toHaveAttribute("type", "password");
		await expect(dialog.getByRole("button", { name: "Copy signing secret" })).toBeInTheDocument();
	},
});

/** An automation manager can replace a signing secret they can't see after an upgrade. */
export const RestrictedMigratedWebhook = meta.story({
	globals: { ...PHONE, theme: "light" },
	beforeEach({ msw }) {
		const secretPath = `${API}/projects/:projectId/automations/${incidentIntake.automation.id}/triggers/:triggerId/secret`;
		const message =
			"Only the workspace owner and admins can see this webhook secret. Anyone who manages the automation can replace it.";
		let replacement: string | undefined;
		msw.use(
			...automationsAnswer([incidentIntake]),
			http.get(secretPath, () =>
				replacement === undefined
					? HttpResponse.json(
							{
								_tag: "Forbidden",
								message,
								error: {
									_tag: "WebhookSecretRestricted",
									userMessage: message,
									isRetryable: false,
								},
							},
							{ status: 403 },
						)
					: HttpResponse.json({ kind: "set", secret: replacement }),
			),
			http.post(secretPath, async ({ request }) => {
				const { secret } = (await request.json()) as { secret: string };
				replacement = secret;
				return HttpResponse.json({ secret });
			}),
			...appHandlers({ role: "editor" }),
		);
	},
	render: () => <StoryApp path={feedPath(incidentIntake)} />,
	play: async ({ canvas, userEvent }) => {
		const dialog = within(await openFirstTrigger(canvas));
		const note = await dialog.findByText(/Anyone who manages the automation can replace it/);
		await waitFor(() => expect(note).toBeVisible());
		const secret = dialog.getByLabelText("Signing secret");
		await expect(secret).toHaveValue("");
		const replacement = "whsec_M2ca9iV54QkY8zG7rC31ALpF";
		await userEvent.type(secret, replacement);
		await userEvent.tab();
		await waitFor(() => expect(note).not.toBeInTheDocument());
		await expect(dialog.getByLabelText("Signing secret")).toHaveValue(replacement);
	},
});

/** A bearer webhook needs a new token before its authentication can change. */
export const LegacyBearerWebhook = meta.story({
	beforeEach({ msw }) {
		const secretPath = `${API}/projects/:projectId/automations/${deployCheck.automation.id}/triggers/:triggerId/secret`;
		msw.use(
			...automationsAnswer([deployCheck]),
			http.get(secretPath, () => HttpResponse.json({ kind: "legacy" })),
			http.post(secretPath, async ({ request }) => {
				const { secret } = (await request.json()) as { secret: string };
				return HttpResponse.json({ secret });
			}),
		);
	},
	render: () => <StoryApp path={feedPath(deployCheck)} />,
	play: async ({ canvas, userEvent }) => {
		const dialog = within(await openFirstTrigger(canvas));
		const legacyNote = await dialog.findByText(/Enter a new token before changing authentication/);
		await waitFor(() => expect(legacyNote).toBeVisible());
		await expect(dialog.getByRole("button", { name: "Auth: Bearer" })).toBeDisabled();
		await expect(dialog.getByRole("button", { name: "Source: Generic" })).toBeDisabled();
		const token = dialog.getByLabelText("Token");
		await expect(token).toHaveValue("");
		await userEvent.type(token, "whsec_R4fT2yH7pN1bG9vJ6kQ3");
		await userEvent.tab();
		await waitFor(() => expect(dialog.getByRole("button", { name: "Auth: Bearer" })).toBeEnabled());
		await expect(dialog.getByRole("button", { name: "Source: Generic" })).toBeEnabled();
	},
});

/** A webhook can switch among automatic detection, a named header, and running every call. */
export const DeliveryIdHeader = meta.story({
	beforeEach({ msw }) {
		let automation: Automation = {
			...incidentIntake.automation,
			triggers: automationTriggers(incidentIntake.automation.id, {
				kind: "webhook",
				auth: { kind: "hmac", header: "X-Signature", algorithm: "sha256", encoding: "hex" },
			}),
		};
		const item = { ...incidentIntake, automation };
		msw.use(
			...automationsAnswer([item]),
			http.put(
				`${API}/projects/:projectId/automations/:automationId/triggers/:triggerId`,
				async ({ request, params }) => {
					const { trigger: input } = (await request.json()) as { trigger: AutomationTriggerInput };
					if (input.kind !== "webhook") return HttpResponse.json({}, { status: 400 });
					const { deliveryIdHeader, ...settings } = input;
					automation = {
						...automation,
						triggers: automation.triggers.map((trigger) =>
							trigger.kind === "webhook" && trigger.id === params.triggerId
								? {
										...trigger,
										...settings,
										deliveryIdHeader:
											deliveryIdHeader === undefined
												? trigger.deliveryIdHeader
												: typeof deliveryIdHeader === "string"
													? deliveryIdHeader
													: deliveryIdHeader === null
														? null
														: undefined,
									}
								: trigger,
						),
					};
					item.automation = automation;
					return HttpResponse.json({ automation, secrets: [] });
				},
			),
		);
	},
	render: () => <StoryApp path={feedPath(incidentIntake)} />,
	play: async ({ canvas, userEvent }) => {
		const dialog = within(await openFirstTrigger(canvas));
		await dialog.findByLabelText("Signing secret");
		await userEvent.click(dialog.getByRole("button", { name: "Delivery ID: Automatic detection" }));
		await userEvent.click(await screen.findByRole("menuitemradio", { name: "Use a header" }));
		const field = await dialog.findByLabelText("Delivery ID header");
		await waitFor(() => expect(field).toBeEnabled());
		await expect(field).toHaveValue("Idempotency-Key");
		await userEvent.clear(field);
		await userEvent.type(field, "X-Request-Id{Enter}");
		await waitFor(async () => {
			const saved = dialog.getByLabelText("Delivery ID header");
			await expect(saved).not.toBe(field);
			await expect(saved).toBeEnabled();
			await expect(saved).toHaveValue("X-Request-Id");
		});
		await userEvent.keyboard("{Escape}");
		const updated = within(await openFirstTrigger(canvas));
		await updated.findByLabelText("Signing secret");
		await waitFor(() =>
			expect(updated.getByLabelText("Delivery ID header")).toHaveValue("X-Request-Id"),
		);
		await userEvent.clear(updated.getByLabelText("Delivery ID header"));
		await userEvent.tab();
		const everyCall = await updated.findByRole("button", { name: "Delivery ID: Every call runs" });
		await waitFor(() => expect(everyCall).toBeEnabled());
		await userEvent.click(everyCall);
		await userEvent.click(
			await screen.findByRole("menuitemradio", { name: "Automatic detection" }),
		);
		const automatic = await updated.findByRole("button", {
			name: "Delivery ID: Automatic detection",
		});
		await waitFor(() => expect(automatic).toBeEnabled());
		await userEvent.keyboard("{Escape}");
		const reopened = within(await openFirstTrigger(canvas));
		await reopened.findByLabelText("Signing secret");
		await expect(
			reopened.getByRole("button", { name: "Delivery ID: Automatic detection" }),
		).toBeInTheDocument();
	},
});

/** The delivery header stays usable in the compact phone trigger editor. */
export const DeliveryIdHeaderOnAPhone = meta.story({
	...DeliveryIdHeader.input,
	globals: { ...PHONE, theme: "light" },
	play: (context) => DeliveryIdHeader.input.play?.(context),
});

/** From Slack, only its signing secret is asked for; Escape puts the saved one back over one pasted in. */
export const SlackWebhook = meta.story({
	render: () => <StoryApp path={feedPath(slackMentions)} />,
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

/** The source menu: Generic, then the webhook sources, whose signing is known, each with its logo; picking one closes it. */
export const SourceMenu = meta.story({
	render: () => <StoryApp path={feedPath(incidentIntake)} />,
	play: async ({ canvas, userEvent }) => {
		const dialog = within(await openFirstTrigger(canvas));
		const source = await dialog.findByRole("button", { name: "Source: Generic" });
		await waitFor(() => expect(source).toBeEnabled());
		await userEvent.click(source);
		const menu = await screen.findByRole("menu");
		for (const source of ["Generic", "GitHub", "Stripe", "Slack", "Linear"]) {
			await expect(within(menu).getByRole("menuitemradio", { name: source })).toBeInTheDocument();
		}
		await userEvent.click(within(menu).getByRole("menuitemradio", { name: "Stripe" }));
		await waitFor(() => expect(screen.queryByRole("menu")).toBeNull());
	},
});

/** Basic auth: a username to set, and a password. */
export const BasicWebhook = meta.story({
	render: () => <StoryApp path={feedPath(signups)} />,
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

/** A repository's events: which of the repositories its project's GitHub app reaches, and what happening there runs it. */
export const RepositoryTrigger = meta.story({
	beforeEach({ msw }) {
		msw.use(...automationsAnswer([...everyAutomation, pullRequestReviews]), ...projectRepositories);
	},
	render: () => <StoryApp path={feedPath(pullRequestReviews)} />,
	play: async ({ canvas }) => {
		const panel = await openPanel(canvas);
		await expect(await panel.findByRole("button", { name: /^On acme\/web/ })).toBeInTheDocument();
		const dialog = within(await openFirstTrigger(canvas));
		// The project's GitHub app, then its repositories, load once the trigger opens.
		await expect(
			await dialog.findByRole("switch", { name: "A pull request is reviewed" }),
		).toBeChecked();
		await expect(dialog.getByRole("switch", { name: "Checks fail" })).not.toBeChecked();
	},
});

/** A new automation on a repository waits for one to be picked, from its project's. */
export const NewRepositoryAutomation = meta.story({
	beforeEach({ msw }) {
		msw.use(...projectRepositories);
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

/** A new automation starts with no routines or triggers, and waits for a name and instructions. */
export const NewAutomation = meta.story({
	render: () => <StoryApp path={newInRevenue} />,
	play: async ({ canvas }) => {
		await expect(
			await canvas.findByRole("heading", { level: 1, name: "New automation" }),
		).toBeInTheDocument();
		await expect(canvas.getByText("No routines")).toBeInTheDocument();
		await expect(canvas.getByText("No triggers")).toBeInTheDocument();
		await expect(canvas.getByRole("button", { name: "Create automation" })).toBeDisabled();
		await expect(canvas.queryByRole("switch", { name: "On" })).toBeNull();
	},
});

/** A routine added: Weekly adds a row of days. */
export const ChoosingDays = meta.story({
	render: () => <StoryApp path={newInRevenue} />,
	play: async ({ canvas, userEvent }) => {
		await userEvent.click(await canvas.findByRole("button", { name: "Add routine" }));
		const dialog = within(await screen.findByRole("dialog", { name: "Routine" }));
		await userEvent.click(dialog.getByRole("radio", { name: "Weekly" }));
		await userEvent.click(dialog.getByRole("checkbox", { name: "Friday" }));
		await expect(dialog.getByText(/Runs every week on Mon and Fri at 9:00/)).toBeInTheDocument();
		await userEvent.click(dialog.getByRole("button", { name: "Add routine" }));
		await expect(
			await canvas.findByRole("button", { name: /^Mon Fri at 9:00/ }),
		).toBeInTheDocument();
	},
});

/** Somebody who may not manage a bot's automations reads them without the controls to change them. */
export const AsAnEditor = meta.story({
	beforeEach({ msw }) {
		// A bot's automations are its default project's, so what may be done with them is the bot's.
		const asEditor = storyBots.map((bot) => ({
			...bot,
			permissions: {
				...bot.permissions,
				resources: {
					...bot.permissions.resources,
					manageAutomations: false,
					pauseAutomations: false,
					runAutomations: false,
				},
			},
		}));
		msw.use(
			...automationsAnswer(everyAutomation),
			...appHandlers({ role: "editor", bots: asEditor }),
		);
	},
	render: () => <StoryApp path={feedPath(overnight)} />,
	play: async ({ canvas }) => {
		const panel = await openPanel(canvas);
		await expect(
			await panel.findByRole("heading", { name: "Overnight outbound" }),
		).toBeInTheDocument();
		const toggle = panel.getByRole("switch", { name: "Automation on" });
		await expect(toggle).toBeDisabled();
		// Why it is off is said in the panel, and read with the switch.
		await expect(toggle).toHaveAccessibleDescription(
			"Only someone who may change this automation can turn it on or off.",
		);
		await expect(panel.queryByRole("button", { name: "Start a run" })).toBeNull();
		await expect(panel.queryByRole("button", { name: /^More for / })).toBeNull();
		await expect(canvas.queryByRole("link", { name: "New automation" })).toBeNull();
		await expect(panel.getByText("Daily at 6:00")).toBeInTheDocument();
		await expect(panel.queryByRole("button", { name: /^Daily at 6:00/ })).toBeNull();
		await expect(panel.queryByRole("button", { name: "Add routine" })).toBeNull();
		await expect(panel.queryByRole("button", { name: "Add trigger" })).toBeNull();
		await expect(panel.queryByRole("button", { name: "Edit instructions" })).toBeNull();
	},
});

/** On a phone an automation being made covers the list, with the way back to it. */
export const PhoneNewAutomation = meta.story({
	globals: PHONE,
	render: () => (
		<StoryApp path={`/${storyWorkspace.slug}/bots/${accountManager.handle}/automations/new`} />
	),
	play: async ({ canvas }) => {
		await expect(await canvas.findByRole("link", { name: "Automations" })).toBeInTheDocument();
		await expect(
			await canvas.findByRole("heading", { name: "New automation" }),
		).toBeInTheDocument();
		await expect(canvas.getByRole("button", { name: "Create automation" })).toBeInTheDocument();
	},
});
