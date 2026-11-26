import type { Automation, Bot } from "@sugabots/contracts";
import { InternalServerError } from "@sugabots/contracts/http";
import { formatTime } from "@sugabots/contracts/routine-schedule-label";
import { automationTriggers, type TestAutomationTrigger } from "@sugabots/contracts/testing";
import { userText } from "@sugabots/errors";
import { fireEvent, screen, waitFor, within } from "@testing-library/react";
import { Effect } from "effect";
import { beforeEach, describe, expect, it, vi } from "vitest";
import {
	apiAnswers,
	bots,
	chatDetails,
	linear,
	mount,
	open,
	personalAssistant,
	triager,
} from "@/api.test-support.tsx";
import { client } from "@/client.test-support.ts";
import { today } from "@/lib/routine-schedule.ts";

vi.mock("@/api.ts", () => import("@/client.test-support.ts"));

const researcher = bots.find((bot) => bot.handle === "customer-research");
if (!researcher) throw new Error("fixture");

function automation(id: string, name: string, projectId: string, expression: string): Automation {
	return {
		id,
		workspaceId: linear.workspaceId,
		projectId,
		name,
		instructions: `${name}, please.`,
		triggers: automationTriggers(id, {
			kind: "routine",
			schedule: { repeat: "cron", expression },
			timezone: "UTC",
			nextScheduledAt: null,
		}),
		state: "enabled",
		createdById: null,
		pausedAfterFailures: false,
		createdAt: "2026-09-18T00:00:00.000Z",
		updatedAt: "2026-09-18T00:00:00.000Z",
	};
}

/** An automation in a bot's default project, with the bot. */
type BotsAutomation = { automation: Automation; bot: Bot };

const morningBrief: BotsAutomation = {
	automation: automation(
		"0199a3a0-0000-7000-8000-0000000000d1",
		"Morning brief",
		linear.defaultProjectId,
		"0 8 * * 1-5",
	),
	bot: linear,
};
const churnReport: BotsAutomation = {
	automation: {
		...automation(
			"0199a3a0-0000-7000-8000-0000000000d2",
			"Weekly churn report",
			researcher.defaultProjectId,
			"0 9 * * 1",
		),
		state: "paused",
	},
	bot: researcher,
};

beforeEach(() => {
	apiAnswers();
});

/** An automation's own page, where it is set up. */
const automationPage = (one: BotsAutomation) =>
	`/suga/bots/${one.bot.handle}/automations/${one.automation.id}`;
/** An automation being made, under the triager's automations. */
const newPage = `/suga/bots/${triager.handle}/automations/new`;

/** The id of `one`'s feed, where its runs post. */
const feedOf = (one: BotsAutomation) =>
	`${one.automation.id.slice(0, -4)}f${one.automation.id.slice(-3)}`;

/**
 * Serves `one` as its bot's only automation, with its feed, and its bot's
 * automations as `one` and `others`: what the automation's page reads to show it.
 */
function serveAutomation(one: BotsAutomation, others: readonly Automation[] = []) {
	const feed = feedOf(one);
	client.api.automations.list.mockImplementation(({ params }: { params: { projectId: string } }) =>
		Effect.succeed(
			[one.automation, ...others].filter((automation) => automation.projectId === params.projectId),
		),
	);
	client.api.chats.projectChats.mockReturnValue(
		Effect.succeed({
			chats: [],
			automations: [
				{
					automation: {
						id: one.automation.id,
						name: one.automation.name,
						state: one.automation.state,
						pausedAfterFailures: false,
					},
					chat: {
						kind: "automation_feed",
						id: feed,
						workspaceId: one.bot.workspaceId,
						title: one.automation.name,
						createdAt: "2026-09-18T00:00:00.000Z",
						updatedAt: "2026-09-18T00:00:00.000Z",
						hostBotId: one.bot.id,
						automationId: one.automation.id,
					},
					mentionsYou: false,
					status: { failing: false, latestRun: null },
				},
			],
		}),
	);
	const details = chatDetails(one.bot);
	client.api.chats.get.mockReturnValue(
		Effect.succeed({
			...details,
			chat: {
				...details.chat,
				id: feed,
				rootChatId: feed,
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
		}),
	);
}

/** Opens `one`'s own page, where it is set up. */
async function openPanel(one: BotsAutomation, others: readonly Automation[] = []) {
	serveAutomation(one, others);
	const { router } = mount(automationPage(one));
	const panel = await showPanel();
	await within(panel).findByRole("heading", { name: one.automation.name });
	return { router, panel };
}

/** The automation's own page, once it shows. */
async function showPanel() {
	return screen.findByRole("region", { name: "Automation" }, { timeout: 5000 });
}

/** Opens the dialog of the trigger whose row's name matches `row`. */
async function openTrigger(row: RegExp) {
	fireEvent.click(await screen.findByRole("button", { name: row }));
	return screen.findByRole("dialog");
}

/** Adds a trigger of the kind named `label`, through the dialog's first step, and gives the dialog. */
async function addTrigger(label: string) {
	fireEvent.click(await screen.findByRole("button", { name: "Add trigger" }));
	const step = await screen.findByRole("dialog", { name: "Add a trigger" });
	fireEvent.click(within(step).getByRole("button", { name: new RegExp(`^${label}`) }));
	return screen.findByRole("dialog", { name: label });
}

/** Opens the dialog that adds a routine, and gives it. */
async function addRoutine() {
	fireEvent.click(await screen.findByRole("button", { name: "Add routine" }));
	return screen.findByRole("dialog", { name: "Routine" });
}

/** The trigger of an automation whose triggers are `trigger` alone, as it is addressed. */
const onlyTrigger = (one: BotsAutomation) => ({
	projectId: one.automation.projectId,
	automationId: one.automation.id,
	triggerId: one.automation.id,
});

/** `one` with `trigger` as its only trigger. */
function withTrigger(one: BotsAutomation, trigger: TestAutomationTrigger): BotsAutomation {
	return {
		...one,
		automation: { ...one.automation, triggers: automationTriggers(one.automation.id, trigger) },
	};
}

/** Picks the time a routine's chip, counted from 1, runs at. */
async function pickTime(chip: number, minutesPastMidnight: number) {
	const trigger = screen.getByRole("combobox", { name: `Time ${chip}` });
	open(trigger);
	// A select takes a click on an option only once the pointer went down on it.
	const option = await screen.findByRole("option", { name: formatTime(minutesPastMidnight) });
	fireEvent.pointerDown(option, { pointerType: "mouse" });
	fireEvent.click(option);
	await waitFor(() => expect(trigger.textContent).toBe(formatTime(minutesPastMidnight)));
}

async function fillNewAutomation(name: string, instructions: string) {
	fireEvent.change(await screen.findByLabelText("Name"), { target: { value: name } });
	fireEvent.click(screen.getByRole("button", { name: /^Instructions/ }));
	fireEvent.change(await screen.findByLabelText("Instructions"), {
		target: { value: instructions },
	});
	fireEvent.click(screen.getByRole("button", { name: "Done" }));
}

describe("a bot's automations", () => {
	it("makes an automation for the bot it was begun from, then opens its page", async () => {
		const timezone = Intl.DateTimeFormat().resolvedOptions().timeZone;
		client.api.automations.create.mockReturnValue(
			Effect.succeed({ automation: morningBrief.automation, secrets: [] }),
		);
		const { router } = mount(newPage);
		await fillNewAutomation("Triage sweep", "Sweep the queue.");
		screen.getByText("No routines");
		screen.getByText("No triggers");
		const routine = await addRoutine();
		fireEvent.click(within(routine).getByRole("radio", { name: "Weekly" }));
		fireEvent.click(within(routine).getByRole("checkbox", { name: "Thursday" }));
		await pickTime(1, 10 * 60);
		within(routine).getByText(/^Runs every week on Mon and Thu at 10:00, your time \(.+\)\.$/);
		fireEvent.click(within(routine).getByRole("button", { name: "Add routine" }));
		await screen.findByRole("button", { name: /^Mon Thu at 10:00/ });
		fireEvent.click(screen.getByRole("button", { name: "Create automation" }));

		await waitFor(() =>
			expect(client.api.automations.create).toHaveBeenCalledWith({
				params: { projectId: triager.defaultProjectId },
				payload: {
					name: "Triage sweep",
					instructions: "Sweep the queue.",
					triggers: [
						{
							kind: "routine",
							schedule: {
								repeat: "weekly",
								every: 1,
								days: ["mon", "thu"],
								times: [10 * 60],
								startsOn: today(),
							},
							timezone,
						},
					],
				},
			}),
		);
		await waitFor(() =>
			expect(router.state.location.pathname).toBe(
				`/suga/bots/${triager.handle}/automations/${morningBrief.automation.id}`,
			),
		);
	});

	it("makes an automation that runs at several times on the last day of every third month", async () => {
		client.api.automations.create.mockReturnValue(
			Effect.succeed({ automation: morningBrief.automation, secrets: [] }),
		);
		mount(newPage);
		await fillNewAutomation("Quarter close", "Close the quarter.");
		await addRoutine();
		fireEvent.click(screen.getByRole("radio", { name: "Monthly" }));
		// Found once: a role query reads the whole page, and the loop can click a month's worth of days.
		const day = screen.getByRole("status", { name: "On the" });
		const dayLater = screen.getByRole("button", { name: "A day later" });
		while (day.textContent !== "last day") fireEvent.click(dayLater);
		fireEvent.click(screen.getByRole("button", { name: "Further apart" }));
		fireEvent.click(screen.getByRole("button", { name: "Further apart" }));
		fireEvent.click(screen.getByRole("button", { name: "Add a time" }));

		expect(screen.getByRole("status", { name: "Every" }).textContent).toBe("3 months");
		screen.getByText(/^Runs every 3 months on the last day at 9:00 and 13:00, your time/);
		fireEvent.click(screen.getByRole("button", { name: "Add routine" }));
		fireEvent.click(await screen.findByRole("button", { name: "Create automation" }));

		await waitFor(() =>
			expect(client.api.automations.create).toHaveBeenCalledWith(
				expect.objectContaining({
					payload: expect.objectContaining({
						triggers: [
							{
								kind: "routine",
								schedule: {
									repeat: "monthly",
									every: 3,
									dayOfMonth: "last",
									times: [9 * 60, 13 * 60],
									startsOn: today(),
								},
								timezone: Intl.DateTimeFormat().resolvedOptions().timeZone,
							},
						],
					}),
				}),
			),
		);
	});

	it("starts afresh when the address moves to making another bot's automation", async () => {
		const { router } = mount(`/suga/bots/${linear.handle}/automations/new`);
		fireEvent.change(await screen.findByLabelText("Name"), { target: { value: "Sentry issues" } });

		await router.navigate({ href: `/suga/bots/${researcher.handle}/automations/new` });

		await waitFor(() => expect((screen.getByLabelText("Name") as HTMLInputElement).value).toBe(""));
	});

	it("lets a member make an automation for their Personal Assistant", async () => {
		mount(`/suga/bots/${personalAssistant.handle}/automations/new`);

		await screen.findByLabelText("Name");
		expect(screen.queryByText("Automations not found")).toBeNull();
	});

	it("goes to the bot's page when an automation being made, with nothing before it, is cancelled", async () => {
		const { router } = mount(`/suga/bots/${researcher.handle}/automations/new`);

		fireEvent.click(await screen.findByRole("button", { name: "Cancel" }));

		// Not its automations, which would bring a bot with none straight back to making one.
		await waitFor(() =>
			expect(router.state.location.pathname).toBe(`/suga/bots/${researcher.handle}`),
		);
		expect(client.api.automations.create).not.toHaveBeenCalled();
	});

	it("makes a webhook with the secret typed for it, which its page shows", async () => {
		const webhook = withTrigger(morningBrief, {
			kind: "webhook",
			deliveryIdHeader: null,
			auth: { kind: "hmac", header: "X-Signature", algorithm: "sha256", encoding: "hex" },
		});
		client.api.automations.create.mockReturnValue(
			Effect.succeed({ automation: webhook.automation, secrets: [] }),
		);
		serveAutomation(webhook);
		const { router } = mount(`/suga/bots/${linear.handle}/automations/new`);
		await fillNewAutomation("Sentry issues", "Fix what you can.");
		const adding = await addTrigger("Webhook");
		within(adding).getByText(/^With no secret, anyone who has the address can run it\./);
		fireEvent.change(within(adding).getByLabelText("Signing secret"), {
			target: { value: "whsec_0123456789abcdefghijklmnop" },
		});
		fireEvent.click(within(adding).getByRole("button", { name: "Add trigger" }));
		await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
		fireEvent.click(screen.getByRole("button", { name: "Create automation" }));

		await waitFor(() =>
			expect(client.api.automations.create).toHaveBeenCalledWith(
				expect.objectContaining({
					payload: expect.objectContaining({
						triggers: [
							{
								kind: "webhook",
								auth: { kind: "hmac", header: "X-Signature", algorithm: "sha256", encoding: "hex" },
								deliveryIdHeader: "Idempotency-Key",
								secret: "whsec_0123456789abcdefghijklmnop",
							},
						],
					}),
				}),
			),
		);
		// Made, it opens its feed; its panel beside it has the address and the secret.
		await waitFor(() => expect(router.state.location.pathname).toBe(automationPage(webhook)));
		const panel = await showPanel();
		fireEvent.click(await within(panel).findByRole("button", { name: /^Webhook/ }));
		await screen.findByText(new RegExp(`/webhooks/triggers/${webhook.automation.id}$`));
		const secret = await screen.findByLabelText("Signing secret");
		await waitFor(() =>
			expect((secret as HTMLInputElement).value).toBe("whsec_0123456789abcdefghijklmnop"),
		);
	});

	it("makes a webhook with the secret its sender made, however short", async () => {
		client.api.automations.create.mockReturnValue(
			Effect.succeed({ automation: morningBrief.automation, secrets: [] }),
		);
		mount(newPage);
		await fillNewAutomation("Stripe events", "Reconcile the payment.");
		await addTrigger("Webhook");
		fireEvent.click(screen.getByRole("button", { name: "Source: Generic" }));
		fireEvent.click(await screen.findByRole("menuitemradio", { name: "Stripe" }));
		expect(screen.queryByLabelText("Header")).toBeNull();
		expect(screen.getByLabelText("Signing secret").getAttribute("placeholder")).toBe("whsec_…");
		fireEvent.change(screen.getByLabelText("Signing secret"), {
			target: { value: " whsec_short " },
		});
		expect(screen.queryByText("A secret needs at least 16 characters.")).toBeNull();
		fireEvent.click(screen.getByRole("button", { name: "Add trigger" }));
		await screen.findByRole("button", { name: /^Webhook/ });
		fireEvent.click(screen.getByRole("button", { name: "Create automation" }));

		await waitFor(() =>
			expect(client.api.automations.create).toHaveBeenCalledWith(
				expect.objectContaining({
					payload: expect.objectContaining({
						triggers: [
							{
								kind: "webhook",
								auth: { kind: "stripe" },
								deliveryIdHeader: "Idempotency-Key",
								secret: "whsec_short",
							},
						],
					}),
				}),
			),
		);
	});

	it("saves a webhook's auth as it changes, and says what a caller sends", async () => {
		const webhook = withTrigger(morningBrief, {
			kind: "webhook",
			deliveryIdHeader: null,
			auth: { kind: "api_key", header: "X-API-Key" },
		});
		client.api.automations.updateTrigger.mockReturnValue(
			Effect.succeed({ automation: webhook.automation, secrets: [] }),
		);
		await openPanel(webhook);
		await openTrigger(/^Webhook/);

		await screen.findByText(/Send the key in the X-API-Key header\./);
		const header = screen.getByLabelText("Header");
		fireEvent.change(header, { target: { value: " X-Signup-Key " } });
		fireEvent.blur(header);
		await waitFor(() =>
			expect(client.api.automations.updateTrigger).toHaveBeenCalledWith({
				params: onlyTrigger(webhook),
				payload: {
					trigger: { kind: "webhook", auth: { kind: "api_key", header: "X-Signup-Key" } },
				},
			}),
		);

		fireEvent.click(screen.getByRole("button", { name: "Auth: API key" }));
		fireEvent.click(await screen.findByRole("menuitemradio", { name: "Basic" }));
		await waitFor(() =>
			expect(client.api.automations.updateTrigger).toHaveBeenCalledWith({
				params: onlyTrigger(webhook),
				payload: { trigger: { kind: "webhook", auth: { kind: "basic", username: "sugabots" } } },
			}),
		);
	});

	it("saves the header a webhook's delivery id is read from, and none when it is cleared", async () => {
		const webhook = withTrigger(morningBrief, {
			kind: "webhook",
			auth: { kind: "bearer" },
			deliveryIdHeader: "Idempotency-Key",
		});
		client.api.automations.updateTrigger.mockReturnValue(
			Effect.succeed({ automation: webhook.automation, secrets: [] }),
		);
		await openPanel(webhook);
		await openTrigger(/^Webhook/);

		const field = () => screen.getByLabelText("Delivery ID header");
		await screen.findByLabelText("Delivery ID header");
		expect((field() as HTMLInputElement).value).toBe("Idempotency-Key");
		fireEvent.change(field(), { target: { value: " X-Request-Id " } });
		fireEvent.blur(field());
		await waitFor(() =>
			expect(client.api.automations.updateTrigger).toHaveBeenLastCalledWith({
				params: onlyTrigger(webhook),
				payload: { trigger: { kind: "webhook", deliveryIdHeader: "X-Request-Id" } },
			}),
		);

		fireEvent.change(field(), { target: { value: "" } });
		fireEvent.blur(field());
		await waitFor(() =>
			expect(client.api.automations.updateTrigger).toHaveBeenLastCalledWith({
				params: onlyTrigger(webhook),
				payload: { trigger: { kind: "webhook", deliveryIdHeader: null } },
			}),
		);
	});

	it("asks a known source for no delivery id header", async () => {
		const webhook = withTrigger(morningBrief, {
			kind: "webhook",
			deliveryIdHeader: null,
			auth: { kind: "github" },
		});
		await openPanel(webhook);
		await openTrigger(/^Webhook/);

		await screen.findByRole("button", { name: "Source: GitHub" });
		expect(screen.queryByLabelText("Delivery ID header")).toBeNull();
	});

	it("saves a webhook filter only after confirmation, and removes tests", async () => {
		const labelled = { path: "data.labels.name", oneOf: ["10x, bug"] };
		let webhook = withTrigger(morningBrief, {
			kind: "webhook",
			deliveryIdHeader: null,
			auth: { kind: "linear" },
			filter: [{ path: "type", oneOf: ["Issue"] }],
		});
		client.api.automations.updateTrigger.mockImplementation(({ payload }) => {
			webhook = withTrigger(morningBrief, {
				kind: "webhook",
				deliveryIdHeader: null,
				auth: { kind: "linear" },
				filter: "filter" in payload.trigger ? payload.trigger.filter : undefined,
			});
			return Effect.succeed({ automation: webhook.automation, secrets: [] });
		});
		await openPanel(webhook);
		client.api.automations.list.mockImplementation(() => Effect.succeed([webhook.automation]));
		await openTrigger(/^Webhook/);
		fireEvent.click(await screen.findByRole("button", { name: "Add test" }));
		fireEvent.change(screen.getByLabelText("JSON path"), {
			target: { value: " data.labels.name " },
		});
		fireEvent.change(screen.getByLabelText("Accepted value 1"), { target: { value: "10x, bug" } });
		fireEvent.blur(screen.getByLabelText("Accepted value 1"));
		expect(client.api.automations.updateTrigger).not.toHaveBeenCalled();
		fireEvent.click(screen.getByRole("button", { name: "Save test" }));
		await waitFor(() =>
			expect(client.api.automations.updateTrigger).toHaveBeenLastCalledWith({
				params: onlyTrigger(webhook),
				payload: {
					trigger: { kind: "webhook", filter: [{ path: "type", oneOf: ["Issue"] }, labelled] },
				},
			}),
		);
		fireEvent.click(await screen.findByRole("button", { name: "Edit test 1" }));
		fireEvent.change(screen.getByLabelText("JSON path"), { target: { value: "" } });
		expect(screen.getByRole("button", { name: "Save test" })).toHaveProperty("disabled", true);
		fireEvent.click(screen.getByRole("button", { name: "Cancel test" }));
		fireEvent.click(screen.getByRole("button", { name: "Remove test 1" }));
		await waitFor(() =>
			expect(client.api.automations.updateTrigger).toHaveBeenLastCalledWith({
				params: onlyTrigger(webhook),
				payload: { trigger: { kind: "webhook", filter: [labelled] } },
			}),
		);
	});

	it("makes a webhook with the filter written for it", async () => {
		client.api.automations.create.mockReturnValue(
			Effect.succeed({ automation: morningBrief.automation, secrets: [] }),
		);
		mount(newPage);
		await fillNewAutomation("Labelled issues", "Fix what you can.");
		await addTrigger("Webhook");
		fireEvent.click(screen.getByRole("button", { name: "Add test" }));
		expect(screen.getByRole("button", { name: "Add trigger" })).toHaveProperty("disabled", true);
		fireEvent.change(screen.getByLabelText("JSON path"), { target: { value: "data.labels.name" } });
		fireEvent.change(screen.getByLabelText("Accepted value 1"), { target: { value: "10x" } });
		fireEvent.click(screen.getByRole("button", { name: "Save test" }));
		await screen.findByRole("button", { name: "Edit test 1" });
		fireEvent.click(screen.getByRole("button", { name: "Add trigger" }));
		await screen.findByRole("button", { name: /^Webhook/ });
		fireEvent.click(screen.getByRole("button", { name: "Create automation" }));

		await waitFor(() =>
			expect(client.api.automations.create).toHaveBeenCalledWith(
				expect.objectContaining({
					payload: expect.objectContaining({
						triggers: [
							expect.objectContaining({
								kind: "webhook",
								filter: [{ path: "data.labels.name", oneOf: ["10x"] }],
							}),
						],
					}),
				}),
			),
		);
	});

	it("keeps a webhook's filter in a copy of its automation", async () => {
		const filter = [{ path: "type", oneOf: ["Issue"] }];
		const webhook = withTrigger(morningBrief, {
			kind: "webhook",
			deliveryIdHeader: null,
			auth: { kind: "linear" },
			filter,
		});
		client.api.automations.create.mockReturnValue(
			Effect.succeed({ automation: webhook.automation, secrets: [] }),
		);
		await openPanel(webhook);

		fireEvent.click(await screen.findByRole("button", { name: "More for Morning brief" }));
		fireEvent.click(await screen.findByRole("menuitem", { name: "Duplicate" }));

		await waitFor(() =>
			expect(client.api.automations.create).toHaveBeenCalledWith(
				expect.objectContaining({
					payload: expect.objectContaining({
						triggers: [
							{ kind: "webhook", auth: { kind: "linear" }, deliveryIdHeader: null, filter },
						],
					}),
				}),
			),
		);
	});

	it("leaves a webhook without a secret when its secret is cleared", async () => {
		const webhook = withTrigger(morningBrief, {
			kind: "webhook",
			deliveryIdHeader: null,
			auth: { kind: "hmac", header: "X-Signature", algorithm: "sha256", encoding: "hex" },
		});
		client.api.automations.rotateSecret.mockReturnValue(Effect.succeed({ secret: null }));
		await openPanel(webhook);
		await openTrigger(/^Webhook/);

		const secret = await screen.findByLabelText("Signing secret");
		await waitFor(() =>
			expect((secret as HTMLInputElement).value).toBe("whsec_0123456789abcdefghijklmnop"),
		);
		fireEvent.change(secret, { target: { value: "" } });
		fireEvent.blur(secret);

		await waitFor(() =>
			expect(client.api.automations.rotateSecret).toHaveBeenCalledWith({
				params: onlyTrigger(webhook),
				payload: { secret: null },
			}),
		);
		await screen.findByText(/^With no secret, anyone who has the address can run it\./);
	});

	it("saves Slack's signing secret pasted over the one it had once the field is left", async () => {
		const slack = withTrigger(morningBrief, {
			kind: "webhook",
			deliveryIdHeader: null,
			auth: { kind: "slack" },
		});
		client.api.automations.rotateSecret.mockReturnValue(
			Effect.succeed({ secret: "8f742231b10e8888abcd99yyyzzz85a5" }),
		);
		await openPanel(slack);
		await openTrigger(/^Webhook/);

		await screen.findByText(/Request URL, and paste its Signing Secret\./);
		const secret = await screen.findByLabelText("Signing secret");
		await waitFor(() =>
			expect((secret as HTMLInputElement).value).toBe("whsec_0123456789abcdefghijklmnop"),
		);
		fireEvent.change(secret, { target: { value: " 8f742231b10e8888abcd99yyyzzz85a5 " } });
		expect(client.api.automations.rotateSecret).not.toHaveBeenCalled();
		fireEvent.blur(secret);

		await waitFor(() =>
			expect(client.api.automations.rotateSecret).toHaveBeenCalledWith({
				params: onlyTrigger(slack),
				payload: { secret: "8f742231b10e8888abcd99yyyzzz85a5" },
			}),
		);
		await waitFor(() =>
			expect((screen.getByLabelText("Signing secret") as HTMLInputElement).value).toBe(
				"8f742231b10e8888abcd99yyyzzz85a5",
			),
		);
	});

	it("asks a generic webhook for a secret long enough to be hard to guess, and says so", async () => {
		const webhook = withTrigger(morningBrief, {
			kind: "webhook",
			deliveryIdHeader: null,
			auth: { kind: "api_key", header: "X-API-Key" },
		});
		await openPanel(webhook);
		await openTrigger(/^Webhook/);

		const key = await screen.findByLabelText("Key");
		fireEvent.change(key, { target: { value: "sk_rt_short" } });
		fireEvent.blur(key);
		screen.getByText("A secret needs at least 16 characters.");
		expect(client.api.automations.rotateSecret).not.toHaveBeenCalled();
		fireEvent.change(key, { target: { value: "sk_rt_0123456789abcdef" } });
		expect(screen.queryByText("A secret needs at least 16 characters.")).toBeNull();
		fireEvent.blur(key);
		await waitFor(() =>
			expect(client.api.automations.rotateSecret).toHaveBeenCalledWith(
				expect.objectContaining({ payload: { secret: "sk_rt_0123456789abcdef" } }),
			),
		);
	});

	it("duplicates an automation, paused and with a name of its own, then opens the copy", async () => {
		const copyOf = (n: number, name: string): BotsAutomation => ({
			...morningBrief,
			automation: {
				...morningBrief.automation,
				id: `0199a3a0-0000-7000-8000-0000000000f${n}`,
				name,
				state: "paused",
			},
		});
		const firstCopy = copyOf(1, "Morning brief copy");
		const secondCopy = copyOf(2, "Morning brief copy 2");
		client.api.automations.create.mockReturnValue(
			Effect.succeed({ automation: secondCopy.automation, secrets: [] }),
		);
		// Its bot already has one copy, so this one takes the next name.
		const { router, panel } = await openPanel(morningBrief, [firstCopy.automation]);

		fireEvent.click(within(panel).getByRole("button", { name: "More for Morning brief" }));
		fireEvent.click(await screen.findByRole("menuitem", { name: "Duplicate" }));

		await waitFor(() =>
			expect(client.api.automations.create).toHaveBeenCalledWith({
				params: { projectId: linear.defaultProjectId },
				payload: {
					name: "Morning brief copy 2",
					instructions: morningBrief.automation.instructions,
					state: "paused",
					triggers: [
						{
							kind: "routine",
							schedule: { repeat: "cron", expression: "0 8 * * 1-5" },
							timezone: "UTC",
						},
					],
				},
			}),
		);
		await waitFor(() => expect(router.state.location.pathname).toBe(automationPage(secondCopy)));
	});

	it("turns an automation back on from its panel", async () => {
		client.api.automations.update.mockReturnValue(
			Effect.succeed({ automation: { ...churnReport.automation, state: "enabled" }, secrets: [] }),
		);
		const { panel } = await openPanel(churnReport);

		const on = within(panel).getByRole("switch", { name: "Automation on" });
		expect(on.getAttribute("aria-checked")).toBe("false");
		fireEvent.click(on);

		await waitFor(() =>
			expect(client.api.automations.update).toHaveBeenCalledWith({
				params: { projectId: researcher.defaultProjectId, automationId: churnReport.automation.id },
				payload: { changes: { state: "enabled" } },
			}),
		);
	});

	it("runs a paused automation now", async () => {
		client.api.automations.run.mockReturnValue(Effect.void);
		await openPanel(churnReport);

		fireEvent.click(await screen.findByRole("button", { name: "Start a run" }));

		await waitFor(() =>
			expect(client.api.automations.run).toHaveBeenCalledWith({
				params: { projectId: researcher.defaultProjectId, automationId: churnReport.automation.id },
				payload: { requestId: expect.any(String) },
			}),
		);
	});

	it("saves instructions written on its page once the box is left, trimmed", async () => {
		client.api.automations.update.mockReturnValue(
			Effect.succeed({ automation: morningBrief.automation, secrets: [] }),
		);
		const { panel } = await openPanel(morningBrief);
		const instructions = within(panel).getByLabelText("Instructions");
		fireEvent.change(instructions, { target: { value: "  Brief the team.  " } });
		expect(client.api.automations.update).not.toHaveBeenCalled();
		fireEvent.blur(instructions);

		await waitFor(() =>
			expect(client.api.automations.update).toHaveBeenCalledWith({
				params: { projectId: linear.defaultProjectId, automationId: morningBrief.automation.id },
				payload: { changes: { instructions: "Brief the team." } },
			}),
		);
	});

	it("saves a routine's change once it is saved, then closes", async () => {
		client.api.automations.updateTrigger.mockReturnValue(
			Effect.succeed({ automation: morningBrief.automation, secrets: [] }),
		);
		await openPanel(morningBrief);
		const routine = await openTrigger(/^Weekdays at 8:00/);

		await pickTime(1, 8 * 60 + 30);
		await pickTime(1, 9 * 60);
		expect(client.api.automations.updateTrigger).not.toHaveBeenCalled();
		fireEvent.click(within(routine).getByRole("button", { name: "Save" }));

		await waitFor(() =>
			expect(client.api.automations.updateTrigger).toHaveBeenCalledWith({
				params: onlyTrigger(morningBrief),
				payload: {
					trigger: {
						kind: "routine",
						schedule: {
							repeat: "weekly",
							every: 1,
							days: ["mon", "tue", "wed", "thu", "fri"],
							times: [9 * 60],
							startsOn: today(),
						},
						timezone: "UTC",
					},
				},
			}),
		);
		expect(client.api.automations.updateTrigger).toHaveBeenCalledTimes(1);
		await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
	});

	it("adds a trigger to an automation, and removes one", async () => {
		client.api.automations.addTrigger.mockReturnValue(
			Effect.succeed({ automation: morningBrief.automation, secrets: [] }),
		);
		client.api.automations.removeTrigger.mockReturnValue(Effect.void);
		await openPanel(morningBrief);

		const adding = await addTrigger("Webhook");
		fireEvent.click(within(adding).getByRole("button", { name: "Add trigger" }));
		await waitFor(() =>
			expect(client.api.automations.addTrigger).toHaveBeenCalledWith({
				params: { projectId: linear.defaultProjectId, automationId: morningBrief.automation.id },
				payload: {
					trigger: {
						kind: "webhook",
						auth: { kind: "hmac", header: "X-Signature", algorithm: "sha256", encoding: "hex" },
						deliveryIdHeader: "Idempotency-Key",
						secret: null,
					},
				},
			}),
		);
		await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());

		const routine = await openTrigger(/^Weekdays at 8:00/);
		fireEvent.click(within(routine).getByRole("button", { name: "Remove" }));
		await waitFor(() =>
			expect(client.api.automations.removeTrigger).toHaveBeenCalledWith({
				params: onlyTrigger(morningBrief),
			}),
		);
	});

	it("keeps a routine's unfamiliar schedule until a repeat replaces it", async () => {
		const hourly = withTrigger(morningBrief, {
			kind: "routine",
			schedule: { repeat: "cron", expression: "15 */2 * * *" },
			timezone: "UTC",
			nextScheduledAt: null,
		});
		client.api.automations.updateTrigger.mockReturnValue(
			Effect.succeed({ automation: hourly.automation, secrets: [] }),
		);
		await openPanel(hourly);
		const routine = await openTrigger(/^Custom schedule/);

		within(routine).getByText("15 */2 * * *");
		expect(within(routine).getByRole("radio", { name: "Daily" })).toHaveProperty("checked", false);
		fireEvent.click(within(routine).getByRole("radio", { name: "Daily" }));
		fireEvent.click(within(routine).getByRole("button", { name: "Save" }));

		await waitFor(() =>
			expect(client.api.automations.updateTrigger).toHaveBeenCalledWith({
				params: onlyTrigger(hourly),
				payload: {
					trigger: {
						kind: "routine",
						schedule: { repeat: "daily", every: 1, times: [9 * 60], startsOn: today() },
						timezone: "UTC",
					},
				},
			}),
		);
	});

	it("says when a change or a new secret fails to save", async () => {
		const webhook = withTrigger(morningBrief, {
			kind: "webhook",
			deliveryIdHeader: null,
			auth: { kind: "bearer" },
		});
		client.api.automations.update.mockReturnValue(
			Effect.fail(new InternalServerError({ message: userText`Update unavailable` })),
		);
		client.api.automations.rotateSecret.mockReturnValue(
			Effect.fail(new InternalServerError({ message: userText`Rotation unavailable` })),
		);
		const { panel } = await openPanel(webhook);

		// Pausing goes through the feed's controls, which say why it failed.
		fireEvent.click(within(panel).getByRole("switch", { name: "Automation on" }));
		expect((await within(panel).findByRole("alert")).textContent).toContain("Update unavailable");

		await openTrigger(/^Webhook/);
		const token = await screen.findByLabelText("Token");
		fireEvent.change(token, { target: { value: "rtb_0123456789abcdefghijklmnop" } });
		expect(client.api.automations.rotateSecret).not.toHaveBeenCalled();
		fireEvent.blur(token);
		await waitFor(() =>
			expect(
				screen
					.getAllByRole("alert")
					.some((alert) => alert.textContent?.includes("Rotation unavailable")),
			).toBe(true),
		);
	});

	it("deletes an automation after asking, then goes back to its bot's automations", async () => {
		client.api.automations.remove.mockReturnValue(Effect.void);
		const { router, panel } = await openPanel(morningBrief);

		fireEvent.click(within(panel).getByRole("button", { name: "More for Morning brief" }));
		fireEvent.click(await screen.findByRole("menuitem", { name: "Delete automation" }));
		const confirm = await screen.findByRole("dialog", { name: "Delete Morning brief?" });
		expect(client.api.automations.remove).not.toHaveBeenCalled();
		fireEvent.click(within(confirm).getByRole("button", { name: "Delete" }));

		await waitFor(() =>
			expect(client.api.automations.remove).toHaveBeenCalledWith({
				params: { projectId: linear.defaultProjectId, automationId: morningBrief.automation.id },
			}),
		);
		await waitFor(() =>
			expect(router.state.location.pathname).toBe(`/suga/bots/${linear.handle}/automations`),
		);
	});

	it("shows an automation its viewer may not manage without a way to change it", async () => {
		client.api.bots.list.mockReturnValue(
			Effect.succeed(
				bots.map((bot) => ({
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
				})),
			),
		);
		const { panel } = await openPanel(morningBrief);

		expect(within(panel).queryByRole("button", { name: "Start a run" })).toBeNull();
		expect(within(panel).queryByRole("button", { name: /^More for / })).toBeNull();
		expect(screen.queryByRole("link", { name: "New automation" })).toBeNull();
		expect(within(panel).getByRole("switch", { name: "Automation on" })).toHaveProperty(
			"disabled",
			true,
		);

		within(panel).getByText("Weekdays at 8:00");
		expect(within(panel).queryByRole("button", { name: /^Weekdays at 8:00/ })).toBeNull();
		expect(within(panel).queryByRole("button", { name: "Add routine" })).toBeNull();
		expect(within(panel).queryByRole("button", { name: "Add trigger" })).toBeNull();
		expect(within(panel).getByLabelText("Instructions")).toHaveProperty("readOnly", true);
	});

	it("shows another member's personal bot automation with only an off switch", async () => {
		client.api.bots.list.mockReturnValue(
			Effect.succeed(
				bots.map((bot) => ({
					...bot,
					permissions: {
						...bot.permissions,
						talk: false,
						resources: {
							...bot.permissions.resources,
							manageAutomations: false,
							pauseAutomations: true,
							runAutomations: false,
						},
					},
				})),
			),
		);
		const { id, name, state } = morningBrief.automation;
		client.api.automations.list.mockReturnValue(
			Effect.succeed([{ id, name, state, restricted: true }]),
		);
		client.api.automations.update.mockReturnValue(
			Effect.succeed({
				automation: { id, name, state: "paused", restricted: true },
				secrets: [],
			}),
		);
		mount(automationPage(morningBrief));
		const off = await screen.findByRole("switch", { name: `Pause ${name}` });
		expect(off).toHaveProperty("disabled", false);
		expect(screen.queryByLabelText("Instructions")).toBeNull();
		expect(screen.queryByRole("button", { name: "Start a run" })).toBeNull();
		expect(client.api.chats.projectChats).not.toHaveBeenCalled();
		expect(client.api.chats.get).not.toHaveBeenCalled();
		expect(client.api.automations.projectRuns).not.toHaveBeenCalled();
		fireEvent.click(off);
		await waitFor(() =>
			expect(client.api.automations.update).toHaveBeenCalledWith({
				params: { projectId: morningBrief.automation.projectId, automationId: id },
				payload: { changes: { state: "paused" } },
			}),
		);
	});
});
