import type { Routine, WorkspaceRoutine } from "@sugabots/contracts";
import { InternalServerError } from "@sugabots/contracts/http";
import { routineTriggers, type TestRoutineTrigger } from "@sugabots/contracts/testing";
import { userText } from "@sugabots/errors";
import { cleanup, fireEvent, screen, waitFor, within } from "@testing-library/react";
import { Effect } from "effect";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { formatTime, today } from "@/lib/routine-schedule.ts";
import {
	agents,
	apiAnswers,
	channelDetails,
	linear,
	mount,
	open,
	pods,
	triager,
} from "@/test-api.tsx";
import { client } from "@/test-client.ts";

vi.mock("@/api.ts", () => import("@/test-client.ts"));

const [suga, sales] = pods;
if (!suga || !sales) throw new Error("fixture");
const researcher = agents.find((agent) => agent.podId === sales.id);
if (!researcher) throw new Error("fixture");

function routine(id: string, name: string, agentId: string, expression: string): Routine {
	return {
		id,
		workspaceId: linear.workspaceId,
		agentId,
		name,
		instructions: `${name}, please.`,
		triggers: routineTriggers(id, {
			kind: "cron",
			schedule: { repeat: "cron", expression },
			timezone: "UTC",
			nextScheduledAt: null,
		}),
		state: "enabled",
		results: "keep_in_run",
		chatId: null,
		createdById: null,
		createdByAgentId: null,
		createdAt: "2026-09-18T00:00:00.000Z",
		updatedAt: "2026-09-18T00:00:00.000Z",
	};
}

const morningBrief: WorkspaceRoutine = {
	routine: routine(
		"0199a3a0-0000-7000-8000-0000000000d1",
		"Morning brief",
		linear.id,
		"0 8 * * 1-5",
	),
	agent: linear,
	pod: { id: suga.id, slug: suga.slug },
};
const churnReport: WorkspaceRoutine = {
	routine: {
		...routine(
			"0199a3a0-0000-7000-8000-0000000000d2",
			"Weekly churn report",
			researcher.id,
			"0 9 * * 1",
		),
		state: "paused",
	},
	agent: researcher,
	pod: { id: sales.id, slug: sales.slug },
};

beforeEach(() => {
	apiAnswers();
	client.api.routines.listInWorkspace.mockReturnValue(
		Effect.succeed({ items: [morningBrief, churnReport] }),
	);
});

afterEach(() => {
	cleanup();
	vi.clearAllMocks();
});

/** A routine's own thread, where its runs post, with the routine set up in the panel beside it. */
const threadPage = (one: WorkspaceRoutine) =>
	`/suga/pods/${one.pod.slug}/routines/${one.routine.id}`;
/** A routine being made beside Suga-Team's routines. */
const newPage = `/suga/pods/${suga.slug}/routines/new`;

/** The id of `one`'s own thread, where its runs post. */
const feedOf = (one: WorkspaceRoutine) =>
	`${one.routine.id.slice(0, -4)}f${one.routine.id.slice(-3)}`;

/**
 * Serves `one` as its pod's only routine, with its own thread, and its bot's
 * routines as `one` and `others`: what the routine's page reads to show it.
 */
function serveRoutine(one: WorkspaceRoutine, others: readonly Routine[] = []) {
	const feed = feedOf(one);
	client.api.routines.listInWorkspace.mockReturnValue(Effect.succeed({ items: [one] }));
	client.api.routines.list.mockImplementation(({ params }: { params: { agentId: string } }) =>
		Effect.succeed(
			[one.routine, ...others].filter((routine) => routine.agentId === params.agentId),
		),
	);
	client.api.chats.list.mockReturnValue(
		Effect.succeed({
			chats: [],
			channels: [],
			threads: [],
			routines: [
				{
					routine: {
						id: one.routine.id,
						name: one.routine.name,
						state: one.routine.state,
						failed: false,
					},
					agent: one.agent,
					conversation: {
						kind: "routine_feed",
						id: feed,
						workspaceId: one.agent.workspaceId,
						podId: one.agent.podId,
						title: one.routine.name,
						createdAt: "2026-09-18T00:00:00.000Z",
						updatedAt: "2026-09-18T00:00:00.000Z",
						hostAgentId: one.agent.id,
						routineId: one.routine.id,
					},
					mentionsYou: false,
				},
			],
		}),
	);
	const details = channelDetails(one.agent);
	client.api.threads.get.mockReturnValue(
		Effect.succeed({
			...details,
			thread: {
				...details.thread,
				id: feed,
				conversationId: feed,
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
		}),
	);
}

/** Opens `one`'s page and its panel, as a person would: Details beside its thread. */
async function openPanel(one: WorkspaceRoutine, others: readonly Routine[] = []) {
	serveRoutine(one, others);
	const router = mount(threadPage(one));
	const panel = await showPanel();
	await within(panel).findByRole("heading", { name: one.routine.name });
	return { router, panel };
}

/**
 * Details on the routine's thread, until its panel shows. The thread's page
 * can mount again as it finishes loading, which drops a click made before.
 */
async function showPanel() {
	return waitFor(
		() => {
			const shown = screen.queryByRole("complementary", { name: "Routine" });
			if (shown) return shown;
			fireEvent.click(screen.getByRole("button", { name: "Details" }));
			throw new Error("The routine's panel isn't open yet");
		},
		{ timeout: 5000 },
	);
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

/** The trigger of a routine whose triggers are `trigger` alone, as it is addressed. */
const onlyTrigger = (one: WorkspaceRoutine) => ({
	agentId: one.routine.agentId,
	routineId: one.routine.id,
	triggerId: one.routine.id,
});

/** `one` with `trigger` as its only trigger. */
function withTrigger(one: WorkspaceRoutine, trigger: TestRoutineTrigger): WorkspaceRoutine {
	return {
		...one,
		routine: { ...one.routine, triggers: routineTriggers(one.routine.id, trigger) },
	};
}

/** Picks the time a schedule's chip, counted from 1, runs at. */
async function pickTime(chip: number, minutesPastMidnight: number) {
	const trigger = screen.getByRole("combobox", { name: `Time ${chip}` });
	open(trigger);
	// A select takes a click on an option only once the pointer went down on it.
	const option = await screen.findByRole("option", { name: formatTime(minutesPastMidnight) });
	fireEvent.pointerDown(option, { pointerType: "mouse" });
	fireEvent.click(option);
	await waitFor(() => expect(trigger.textContent).toBe(formatTime(minutesPastMidnight)));
}

describe("a pod's routines", () => {
	it("makes a routine for the bot chosen from the pod's own, then opens its thread", async () => {
		const timezone = Intl.DateTimeFormat().resolvedOptions().timeZone;
		client.api.routines.create.mockReturnValue(
			Effect.succeed({ routine: morningBrief.routine, secrets: [] }),
		);
		const router = mount(newPage);
		fireEvent.change(await screen.findByLabelText("Name"), { target: { value: "Triage sweep" } });
		fireEvent.click(screen.getByRole("button", { name: /^Bot(?!s\b)/ }));
		// Only this pod's bots: a routine is kept beside its bot's pod.
		expect(screen.queryByRole("button", { name: researcher.name })).toBeNull();
		fireEvent.click(screen.getByRole("button", { name: triager.name }));
		fireEvent.click(screen.getByRole("button", { name: /^Instructions/ }));
		fireEvent.change(await screen.findByLabelText("Instructions"), {
			target: { value: "Sweep the queue." },
		});
		fireEvent.click(screen.getByRole("button", { name: "Done" }));
		expect(screen.getByText("No triggers")).toBeDefined();
		const schedule = await addTrigger("Schedule");
		fireEvent.click(within(schedule).getByRole("radio", { name: "Weekly" }));
		fireEvent.click(within(schedule).getByRole("checkbox", { name: "Thursday" }));
		await pickTime(1, 10 * 60);
		expect(
			within(schedule).getByText(/^Runs every week on Mon and Thu at 10:00, your time \(.+\)\.$/),
		).toBeDefined();
		fireEvent.click(within(schedule).getByRole("button", { name: "Add trigger" }));
		expect(await screen.findByRole("button", { name: /^Mon Thu at 10:00/ })).toBeDefined();
		fireEvent.click(screen.getByRole("button", { name: "Create routine" }));

		await waitFor(() =>
			expect(client.api.routines.create).toHaveBeenCalledWith({
				params: { agentId: triager.id },
				payload: {
					name: "Triage sweep",
					instructions: "Sweep the queue.",
					results: "post_to_chat",
					triggers: [
						{
							kind: "cron",
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
		await waitFor(() => expect(router.state.location.pathname).toBe(threadPage(morningBrief)));
	});

	it("makes a routine that runs at several times on the last day of every third month", async () => {
		client.api.routines.create.mockReturnValue(
			Effect.succeed({ routine: morningBrief.routine, secrets: [] }),
		);
		mount(newPage);
		fireEvent.change(await screen.findByLabelText("Name"), { target: { value: "Quarter close" } });
		fireEvent.click(screen.getByRole("button", { name: /^Instructions/ }));
		fireEvent.change(await screen.findByLabelText("Instructions"), {
			target: { value: "Close the quarter." },
		});
		fireEvent.click(screen.getByRole("button", { name: "Done" }));
		await addTrigger("Schedule");
		fireEvent.click(screen.getByRole("radio", { name: "Monthly" }));
		while (screen.getByRole("status", { name: "On the" }).textContent !== "last day") {
			fireEvent.click(screen.getByRole("button", { name: "A day later" }));
		}
		fireEvent.click(screen.getByRole("button", { name: "Further apart" }));
		fireEvent.click(screen.getByRole("button", { name: "Further apart" }));
		fireEvent.click(screen.getByRole("button", { name: "Add a time" }));

		expect(screen.getByRole("status", { name: "Every" }).textContent).toBe("3 months");
		expect(
			screen.getByText(/^Runs every 3 months on the last day at 9:00 and 13:00, your time/),
		).toBeDefined();
		fireEvent.click(screen.getByRole("button", { name: "Add trigger" }));
		fireEvent.click(await screen.findByRole("button", { name: "Create routine" }));

		await waitFor(() =>
			expect(client.api.routines.create).toHaveBeenCalledWith(
				expect.objectContaining({
					payload: expect.objectContaining({
						triggers: [
							{
								kind: "cron",
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

	it("makes a routine begun from a bot's routines for that bot, with no other to choose", async () => {
		client.api.routines.create.mockReturnValue(
			Effect.succeed({ routine: churnReport.routine, secrets: [] }),
		);
		mount(`/suga/pods/${sales.slug}/routines/new?bot=${researcher.handle}`);

		expect(await screen.findByText(researcher.name, { selector: "main *" })).toBeDefined();
		expect(screen.queryByRole("button", { name: /^Bot(?!s\b)/ })).toBeNull();
		fireEvent.change(screen.getByLabelText("Name"), { target: { value: "Pipeline check" } });
		fireEvent.click(screen.getByRole("button", { name: /^Instructions/ }));
		fireEvent.change(await screen.findByLabelText("Instructions"), {
			target: { value: "Check the pipeline." },
		});
		fireEvent.click(screen.getByRole("button", { name: "Done" }));
		fireEvent.click(await screen.findByRole("button", { name: "Create routine" }));

		await waitFor(() =>
			expect(client.api.routines.create).toHaveBeenCalledWith(
				expect.objectContaining({ params: { agentId: researcher.id } }),
			),
		);
	});

	it("goes back to the bot's routines when a routine being made is cancelled", async () => {
		const router = mount(`/suga/pods/${sales.slug}/routines/new?bot=${researcher.handle}`);

		fireEvent.click(await screen.findByRole("button", { name: "Cancel" }));

		await waitFor(() =>
			expect(router.state.location.pathname).toBe(`/suga/pods/${sales.slug}/routines`),
		);
		expect(router.state.location.search).toEqual({ bot: researcher.handle });
		expect(client.api.routines.create).not.toHaveBeenCalled();
	});

	it("makes a webhook with the secret typed for it, which its page shows", async () => {
		const webhook = withTrigger(morningBrief, {
			kind: "webhook",
			auth: { kind: "hmac", header: "X-Signature", algorithm: "sha256", encoding: "hex" },
		});
		client.api.routines.create.mockReturnValue(
			Effect.succeed({ routine: webhook.routine, secrets: [] }),
		);
		serveRoutine(webhook);
		const router = mount(newPage);
		fireEvent.change(await screen.findByLabelText("Name"), { target: { value: "Sentry issues" } });
		fireEvent.click(screen.getByRole("button", { name: /^Instructions/ }));
		fireEvent.change(await screen.findByLabelText("Instructions"), {
			target: { value: "Fix what you can." },
		});
		fireEvent.click(screen.getByRole("button", { name: "Done" }));
		const adding = await addTrigger("Webhook");
		expect(
			within(adding).getByText(/^With no secret, anyone who has the address can run it\./),
		).toBeDefined();
		fireEvent.change(within(adding).getByLabelText("Signing secret"), {
			target: { value: "whsec_0123456789abcdefghijklmnop" },
		});
		fireEvent.click(within(adding).getByRole("button", { name: "Add trigger" }));
		await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
		const posted = screen.getByRole("switch", { name: "Also post result in the pod's channel" });
		expect(posted.getAttribute("aria-checked")).toBe("false");
		fireEvent.click(screen.getByRole("button", { name: "Create routine" }));

		await waitFor(() =>
			expect(client.api.routines.create).toHaveBeenCalledWith(
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
						results: "keep_in_run",
					}),
				}),
			),
		);
		// Made, it opens its thread; its panel beside it has the address and the secret.
		await waitFor(() => expect(router.state.location.pathname).toBe(threadPage(webhook)));
		const panel = await showPanel();
		fireEvent.click(await within(panel).findByRole("button", { name: /^Webhook/ }));
		expect(
			await screen.findByText(new RegExp(`/hooks/triggers/${webhook.routine.id}$`)),
		).toBeDefined();
		const secret = await screen.findByLabelText("Signing secret");
		await waitFor(() =>
			expect((secret as HTMLInputElement).value).toBe("whsec_0123456789abcdefghijklmnop"),
		);
	});

	it("makes a webhook with the secret its sender made, however short", async () => {
		client.api.routines.create.mockReturnValue(
			Effect.succeed({ routine: morningBrief.routine, secrets: [] }),
		);
		mount(newPage);
		fireEvent.change(await screen.findByLabelText("Name"), { target: { value: "Stripe events" } });
		fireEvent.click(screen.getByRole("button", { name: /^Instructions/ }));
		fireEvent.change(await screen.findByLabelText("Instructions"), {
			target: { value: "Reconcile the payment." },
		});
		fireEvent.click(screen.getByRole("button", { name: "Done" }));
		await addTrigger("Webhook");
		fireEvent.click(screen.getByRole("button", { name: "Source: Generic" }));
		fireEvent.click(await screen.findByRole("menuitem", { name: "Stripe" }));
		expect(screen.queryByLabelText("Header")).toBeNull();
		expect(screen.getByLabelText("Signing secret").getAttribute("placeholder")).toBe("whsec_…");
		fireEvent.change(screen.getByLabelText("Signing secret"), {
			target: { value: " whsec_short " },
		});
		expect(screen.queryByText("A secret needs at least 16 characters.")).toBeNull();
		fireEvent.click(screen.getByRole("button", { name: "Add trigger" }));
		expect(await screen.findByRole("button", { name: /^Webhook/ })).toBeDefined();
		fireEvent.click(screen.getByRole("button", { name: "Create routine" }));

		await waitFor(() =>
			expect(client.api.routines.create).toHaveBeenCalledWith(
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
			auth: { kind: "api_key", header: "X-API-Key" },
		});
		client.api.routines.listInWorkspace.mockReturnValue(Effect.succeed({ items: [webhook] }));
		client.api.routines.updateTrigger.mockReturnValue(
			Effect.succeed({ routine: webhook.routine, secrets: [] }),
		);
		await openPanel(webhook);
		await openTrigger(/^Webhook/);

		expect(await screen.findByText(/Send the key in the X-API-Key header\./)).toBeDefined();
		const header = screen.getByLabelText("Header");
		fireEvent.change(header, { target: { value: " X-Signup-Key " } });
		fireEvent.blur(header);
		await waitFor(() =>
			expect(client.api.routines.updateTrigger).toHaveBeenCalledWith({
				params: onlyTrigger(webhook),
				payload: { kind: "webhook", auth: { kind: "api_key", header: "X-Signup-Key" } },
			}),
		);

		fireEvent.click(screen.getByRole("button", { name: "Auth: API key" }));
		fireEvent.click(await screen.findByRole("menuitem", { name: "Basic" }));
		await waitFor(() =>
			expect(client.api.routines.updateTrigger).toHaveBeenCalledWith({
				params: onlyTrigger(webhook),
				payload: { kind: "webhook", auth: { kind: "basic", username: "sugabots" } },
			}),
		);
	});

	it("shows automatic detection without rewriting an existing webhook", async () => {
		const webhook = withTrigger(morningBrief, { kind: "webhook", auth: { kind: "bearer" } });
		await openPanel(webhook);
		await openTrigger(/^Webhook/);
		expect(screen.getByRole("button", { name: "Delivery ID: Automatic detection" })).toBeDefined();
		expect(client.api.routines.updateTrigger).not.toHaveBeenCalled();
	});

	it("saves the header a webhook's delivery id is read from, and none when it is cleared", async () => {
		const webhook = withTrigger(morningBrief, {
			kind: "webhook",
			auth: { kind: "bearer" },
			deliveryIdHeader: "Idempotency-Key",
		});
		client.api.routines.listInWorkspace.mockReturnValue(Effect.succeed({ items: [webhook] }));
		client.api.routines.updateTrigger.mockReturnValue(
			Effect.succeed({ routine: webhook.routine, secrets: [] }),
		);
		await openPanel(webhook);
		await openTrigger(/^Webhook/);

		const field = () => screen.getByLabelText("Delivery ID header");
		await screen.findByLabelText("Delivery ID header");
		expect((field() as HTMLInputElement).value).toBe("Idempotency-Key");
		fireEvent.change(field(), { target: { value: " X-Request-Id " } });
		fireEvent.blur(field());
		await waitFor(() =>
			expect(client.api.routines.updateTrigger).toHaveBeenLastCalledWith({
				params: onlyTrigger(webhook),
				payload: { kind: "webhook", deliveryIdHeader: "X-Request-Id" },
			}),
		);

		fireEvent.change(field(), { target: { value: "" } });
		fireEvent.blur(field());
		await waitFor(() =>
			expect(client.api.routines.updateTrigger).toHaveBeenLastCalledWith({
				params: onlyTrigger(webhook),
				payload: { kind: "webhook", deliveryIdHeader: null },
			}),
		);
	});

	it("asks a known source for no delivery id header", async () => {
		const webhook = withTrigger(morningBrief, { kind: "webhook", auth: { kind: "github" } });
		client.api.routines.listInWorkspace.mockReturnValue(Effect.succeed({ items: [webhook] }));
		await openPanel(webhook);
		await openTrigger(/^Webhook/);

		expect(await screen.findByRole("button", { name: "Source: GitHub" })).toBeDefined();
		expect(screen.queryByLabelText("Delivery ID header")).toBeNull();
	});

	it("saves a webhook's filter as conditions are added, changed and removed", async () => {
		const labelled = { path: "data.labels.name", oneOf: ["10x", "bug"] };
		let webhook = withTrigger(morningBrief, {
			kind: "webhook",
			auth: { kind: "linear" },
			filter: [{ path: "type", oneOf: ["Issue"] }],
		});
		const first = webhook;
		client.api.routines.listInWorkspace.mockImplementation(() =>
			Effect.succeed({ items: [webhook] }),
		);
		// The server keeps what was saved, so the list read after a save has it.
		client.api.routines.updateTrigger.mockImplementation(({ payload }) => {
			webhook = withTrigger(morningBrief, {
				kind: "webhook",
				auth: { kind: "linear" },
				filter: "filter" in payload ? payload.filter : undefined,
			});
			return Effect.succeed({ routine: webhook.routine, secrets: [] });
		});
		const saved = (filter: unknown) =>
			expect(client.api.routines.updateTrigger).toHaveBeenLastCalledWith({
				params: onlyTrigger(first),
				payload: { kind: "webhook", filter },
			});
		mount(routinePage(first));
		await openTrigger(/^Webhook/);

		fireEvent.click(await screen.findByRole("button", { name: "Add condition" }));
		fireEvent.change(screen.getByLabelText("Path 2"), { target: { value: " data.labels.name " } });
		fireEvent.blur(screen.getByLabelText("Path 2"));
		expect(client.api.routines.updateTrigger).not.toHaveBeenCalled();
		fireEvent.change(screen.getByLabelText("Values 2"), { target: { value: "10x, bug," } });
		fireEvent.blur(screen.getByLabelText("Values 2"));
		await waitFor(() => saved([{ path: "type", oneOf: ["Issue"] }, labelled]));

		fireEvent.change(screen.getByLabelText("Values 1"), { target: { value: "" } });
		fireEvent.blur(screen.getByLabelText("Values 1"));
		expect((screen.getByLabelText("Values 1") as HTMLInputElement).value).toBe("Issue");
		expect(client.api.routines.updateTrigger).toHaveBeenCalledTimes(1);

		fireEvent.click(screen.getByRole("button", { name: "Remove condition 1" }));
		await waitFor(() => saved([labelled]));
	});

	it("makes a webhook with the filter written for it", async () => {
		client.api.routines.create.mockReturnValue(
			Effect.succeed({ routine: morningBrief.routine, secrets: [] }),
		);
		mount("/suga/settings/routines/new");
		fireEvent.change(await screen.findByLabelText("Name"), {
			target: { value: "Labelled issues" },
		});
		fireEvent.click(screen.getByRole("button", { name: /^Instructions/ }));
		fireEvent.change(await screen.findByLabelText("Instructions"), {
			target: { value: "Fix what you can." },
		});
		fireEvent.click(screen.getByRole("button", { name: "Done" }));
		await addTrigger("Webhook");
		fireEvent.click(screen.getByRole("button", { name: "Add condition" }));
		fireEvent.change(screen.getByLabelText("Path 1"), { target: { value: "data.labels.name" } });
		fireEvent.change(screen.getByLabelText("Values 1"), { target: { value: "10x" } });
		fireEvent.blur(screen.getByLabelText("Values 1"));
		expect(await screen.findByRole("group", { name: "Condition 1" })).toBeDefined();
		fireEvent.click(screen.getByRole("button", { name: "Add trigger" }));
		expect(await screen.findByRole("button", { name: /^Webhook/ })).toBeDefined();
		fireEvent.click(screen.getByRole("button", { name: "Create routine" }));

		await waitFor(() =>
			expect(client.api.routines.create).toHaveBeenCalledWith(
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

	it("keeps a webhook's filter in a copy of its routine", async () => {
		const filter = [{ path: "type", oneOf: ["Issue"] }];
		const webhook = withTrigger(morningBrief, {
			kind: "webhook",
			auth: { kind: "linear" },
			filter,
		});
		client.api.routines.listInWorkspace.mockReturnValue(Effect.succeed({ items: [webhook] }));
		client.api.routines.create.mockReturnValue(
			Effect.succeed({ routine: webhook.routine, secrets: [] }),
		);
		mount(routinePage(webhook));

		fireEvent.click(await screen.findByRole("button", { name: "More" }));
		fireEvent.click(await screen.findByRole("menuitem", { name: "Duplicate" }));

		await waitFor(() =>
			expect(client.api.routines.create).toHaveBeenCalledWith(
				expect.objectContaining({
					payload: expect.objectContaining({
						triggers: [{ kind: "webhook", auth: { kind: "linear" }, filter }],
					}),
				}),
			),
		);
	});

	it("leaves a webhook without a secret when its secret is cleared", async () => {
		const webhook = withTrigger(morningBrief, {
			kind: "webhook",
			auth: { kind: "hmac", header: "X-Signature", algorithm: "sha256", encoding: "hex" },
		});
		client.api.routines.listInWorkspace.mockReturnValue(Effect.succeed({ items: [webhook] }));
		client.api.routines.rotateSecret.mockReturnValue(Effect.succeed({ secret: null }));
		await openPanel(webhook);
		await openTrigger(/^Webhook/);

		const secret = await screen.findByLabelText("Signing secret");
		await waitFor(() =>
			expect((secret as HTMLInputElement).value).toBe("whsec_0123456789abcdefghijklmnop"),
		);
		fireEvent.change(secret, { target: { value: "" } });
		fireEvent.blur(secret);

		await waitFor(() =>
			expect(client.api.routines.rotateSecret).toHaveBeenCalledWith({
				params: onlyTrigger(webhook),
				payload: { secret: null },
			}),
		);
		expect(
			await screen.findByText(/^With no secret, anyone who has the address can run it\./),
		).toBeDefined();
	});

	it("saves Slack's signing secret pasted over the one it had once the field is left", async () => {
		const slack = withTrigger(morningBrief, { kind: "webhook", auth: { kind: "slack" } });
		client.api.routines.listInWorkspace.mockReturnValue(Effect.succeed({ items: [slack] }));
		client.api.routines.rotateSecret.mockReturnValue(
			Effect.succeed({ secret: "8f742231b10e8888abcd99yyyzzz85a5" }),
		);
		await openPanel(slack);
		await openTrigger(/^Webhook/);

		expect(await screen.findByText(/Request URL, and paste its Signing Secret\./)).toBeDefined();
		const secret = await screen.findByLabelText("Signing secret");
		await waitFor(() =>
			expect((secret as HTMLInputElement).value).toBe("whsec_0123456789abcdefghijklmnop"),
		);
		fireEvent.change(secret, { target: { value: " 8f742231b10e8888abcd99yyyzzz85a5 " } });
		expect(client.api.routines.rotateSecret).not.toHaveBeenCalled();
		fireEvent.blur(secret);

		await waitFor(() =>
			expect(client.api.routines.rotateSecret).toHaveBeenCalledWith({
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
			auth: { kind: "api_key", header: "X-API-Key" },
		});
		client.api.routines.listInWorkspace.mockReturnValue(Effect.succeed({ items: [webhook] }));
		await openPanel(webhook);
		await openTrigger(/^Webhook/);

		const key = await screen.findByLabelText("Key");
		fireEvent.change(key, { target: { value: "sk_rt_short" } });
		fireEvent.blur(key);
		expect(screen.getByText("A secret needs at least 16 characters.")).toBeDefined();
		expect(client.api.routines.rotateSecret).not.toHaveBeenCalled();
		fireEvent.change(key, { target: { value: "sk_rt_0123456789abcdef" } });
		expect(screen.queryByText("A secret needs at least 16 characters.")).toBeNull();
		fireEvent.blur(key);
		await waitFor(() =>
			expect(client.api.routines.rotateSecret).toHaveBeenCalledWith(
				expect.objectContaining({ payload: { secret: "sk_rt_0123456789abcdef" } }),
			),
		);
	});

	it("duplicates a routine, paused and with a name of its own, then opens the copy", async () => {
		const copyOf = (n: number, name: string): WorkspaceRoutine => ({
			...morningBrief,
			routine: {
				...morningBrief.routine,
				id: `0199a3a0-0000-7000-8000-0000000000f${n}`,
				name,
				state: "paused",
			},
		});
		const firstCopy = copyOf(1, "Morning brief copy");
		const secondCopy = copyOf(2, "Morning brief copy 2");
		client.api.routines.create.mockReturnValue(
			Effect.succeed({ routine: secondCopy.routine, secrets: [] }),
		);
		// Its bot already has one copy, so this one takes the next name.
		const { router, panel } = await openPanel(morningBrief, [firstCopy.routine]);

		fireEvent.click(within(panel).getByRole("button", { name: "More for Morning brief" }));
		fireEvent.click(await screen.findByRole("menuitem", { name: "Duplicate" }));

		await waitFor(() =>
			expect(client.api.routines.create).toHaveBeenCalledWith({
				params: { agentId: linear.id },
				payload: {
					name: "Morning brief copy 2",
					instructions: morningBrief.routine.instructions,
					results: morningBrief.routine.results,
					state: "paused",
					triggers: [
						{
							kind: "cron",
							schedule: { repeat: "cron", expression: "0 8 * * 1-5" },
							timezone: "UTC",
						},
					],
				},
			}),
		);
		await waitFor(() => expect(router.state.location.pathname).toBe(threadPage(secondCopy)));
	});

	it("turns a routine back on from its panel", async () => {
		client.api.routines.update.mockReturnValue(
			Effect.succeed({ routine: { ...churnReport.routine, state: "enabled" }, secrets: [] }),
		);
		const { panel } = await openPanel(churnReport);

		const on = within(panel).getByRole("switch", { name: "Routine on" });
		expect(on.getAttribute("aria-checked")).toBe("false");
		fireEvent.click(on);

		await waitFor(() =>
			expect(client.api.routines.update).toHaveBeenCalledWith({
				params: { agentId: researcher.id, routineId: churnReport.routine.id },
				payload: { state: "enabled" },
			}),
		);
	});

	it("runs a paused routine now", async () => {
		client.api.routines.run.mockReturnValue(
			Effect.succeed({
				executionId: "0199a3a0-0000-7000-8000-0000000000e1",
				threadId: "0199a3a0-0000-7000-8000-0000000000e2",
				duplicate: false,
			}),
		);
		await openPanel(churnReport);

		fireEvent.click(await screen.findByRole("button", { name: "Run now" }));

		await waitFor(() =>
			expect(client.api.routines.run).toHaveBeenCalledWith({
				params: { agentId: researcher.id, routineId: churnReport.routine.id },
				payload: { requestId: expect.any(String) },
			}),
		);
	});

	it("saves instructions from their dialog, then closes it", async () => {
		client.api.routines.update.mockReturnValue(
			Effect.succeed({ routine: morningBrief.routine, secrets: [] }),
		);
		const { panel } = await openPanel(morningBrief);
		fireEvent.click(within(panel).getByRole("button", { name: "Edit instructions" }));
		const dialog = await screen.findByRole("dialog", { name: "Instructions" });
		const save = within(dialog).getByRole("button", { name: "Save" });
		expect(save).toHaveProperty("disabled", true);
		fireEvent.change(within(dialog).getByLabelText("Instructions"), {
			target: { value: "  Brief the team.  " },
		});
		fireEvent.click(save);

		await waitFor(() =>
			expect(client.api.routines.update).toHaveBeenCalledWith({
				params: { agentId: linear.id, routineId: morningBrief.routine.id },
				payload: { instructions: "Brief the team." },
			}),
		);
		await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
	});

	it("saves a schedule's change once it is saved, then closes", async () => {
		client.api.routines.updateTrigger.mockReturnValue(
			Effect.succeed({ routine: morningBrief.routine, secrets: [] }),
		);
		await openPanel(morningBrief);
		const schedule = await openTrigger(/^Schedule.*Weekdays at 8:00/);

		await pickTime(1, 8 * 60 + 30);
		await pickTime(1, 9 * 60);
		expect(client.api.routines.updateTrigger).not.toHaveBeenCalled();
		fireEvent.click(within(schedule).getByRole("button", { name: "Save" }));

		await waitFor(() =>
			expect(client.api.routines.updateTrigger).toHaveBeenCalledWith({
				params: onlyTrigger(morningBrief),
				payload: {
					kind: "cron",
					schedule: {
						repeat: "weekly",
						every: 1,
						days: ["mon", "tue", "wed", "thu", "fri"],
						times: [9 * 60],
						startsOn: today(),
					},
					timezone: "UTC",
				},
			}),
		);
		expect(client.api.routines.updateTrigger).toHaveBeenCalledTimes(1);
		await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
	});

	it("adds a trigger to a routine, and removes one", async () => {
		client.api.routines.addTrigger.mockReturnValue(
			Effect.succeed({ routine: morningBrief.routine, secrets: [] }),
		);
		client.api.routines.removeTrigger.mockReturnValue(Effect.void);
		await openPanel(morningBrief);

		const adding = await addTrigger("Webhook");
		fireEvent.click(within(adding).getByRole("button", { name: "Add trigger" }));
		await waitFor(() =>
			expect(client.api.routines.addTrigger).toHaveBeenCalledWith({
				params: { agentId: linear.id, routineId: morningBrief.routine.id },
				payload: {
					kind: "webhook",
					auth: { kind: "hmac", header: "X-Signature", algorithm: "sha256", encoding: "hex" },
					deliveryIdHeader: "Idempotency-Key",
					secret: null,
				},
			}),
		);
		await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());

		const schedule = await openTrigger(/^Schedule.*Weekdays at 8:00/);
		fireEvent.click(within(schedule).getByRole("button", { name: "Remove" }));
		await waitFor(() =>
			expect(client.api.routines.removeTrigger).toHaveBeenCalledWith({
				params: onlyTrigger(morningBrief),
			}),
		);
	});

	it("keeps an unfamiliar schedule until a repeat replaces it", async () => {
		const hourly = withTrigger(morningBrief, {
			kind: "cron",
			schedule: { repeat: "cron", expression: "15 */2 * * *" },
			timezone: "UTC",
			nextScheduledAt: null,
		});
		client.api.routines.listInWorkspace.mockReturnValue(Effect.succeed({ items: [hourly] }));
		client.api.routines.updateTrigger.mockReturnValue(
			Effect.succeed({ routine: hourly.routine, secrets: [] }),
		);
		await openPanel(hourly);
		const schedule = await openTrigger(/^Schedule/);

		expect(within(schedule).getByText("15 */2 * * *")).toBeDefined();
		expect(within(schedule).getByRole("radio", { name: "Daily" })).toHaveProperty("checked", false);
		fireEvent.click(within(schedule).getByRole("radio", { name: "Daily" }));
		fireEvent.click(within(schedule).getByRole("button", { name: "Save" }));

		await waitFor(() =>
			expect(client.api.routines.updateTrigger).toHaveBeenCalledWith({
				params: onlyTrigger(hourly),
				payload: {
					kind: "cron",
					schedule: { repeat: "daily", every: 1, times: [9 * 60], startsOn: today() },
					timezone: "UTC",
				},
			}),
		);
	});

	it("says when a change or a new secret fails to save", async () => {
		const webhook = withTrigger(morningBrief, { kind: "webhook", auth: { kind: "bearer" } });
		client.api.routines.update.mockReturnValue(
			Effect.fail(new InternalServerError({ message: userText`Update unavailable` })),
		);
		client.api.routines.rotateSecret.mockReturnValue(
			Effect.fail(new InternalServerError({ message: userText`Rotation unavailable` })),
		);
		const { panel } = await openPanel(webhook);

		// Pausing goes through the thread's controls, a change through the panel's own: both say why.
		fireEvent.click(within(panel).getByRole("switch", { name: "Routine on" }));
		expect((await within(panel).findByRole("alert")).textContent).toContain("Update unavailable");
		fireEvent.click(
			within(panel).getByRole("switch", { name: "Also post result in the pod's channel" }),
		);
		await waitFor(() => expect(within(panel).getAllByRole("alert")).toHaveLength(2));

		await openTrigger(/^Webhook/);
		const token = await screen.findByLabelText("Token");
		fireEvent.change(token, { target: { value: "rtb_0123456789abcdefghijklmnop" } });
		expect(client.api.routines.rotateSecret).not.toHaveBeenCalled();
		fireEvent.blur(token);
		await waitFor(() =>
			expect(
				screen
					.getAllByRole("alert")
					.some((alert) => alert.textContent?.includes("Rotation unavailable")),
			).toBe(true),
		);
	});

	it("deletes a routine after asking, then goes back to its bot's routines", async () => {
		client.api.routines.remove.mockReturnValue(Effect.void);
		const { router, panel } = await openPanel(morningBrief);

		fireEvent.click(within(panel).getByRole("button", { name: "More for Morning brief" }));
		fireEvent.click(await screen.findByRole("menuitem", { name: "Delete routine" }));
		const confirm = await screen.findByRole("dialog", { name: "Delete Morning brief?" });
		expect(client.api.routines.remove).not.toHaveBeenCalled();
		fireEvent.click(within(confirm).getByRole("button", { name: "Delete" }));

		await waitFor(() =>
			expect(client.api.routines.remove).toHaveBeenCalledWith({
				params: { agentId: linear.id, routineId: morningBrief.routine.id },
			}),
		);
		await waitFor(() =>
			expect(router.state.location.pathname).toBe(`/suga/pods/${suga.slug}/routines`),
		);
		expect(router.state.location.search).toEqual({ bot: linear.handle });
	});

	it("shows a routine its viewer may not manage without a way to change it", async () => {
		client.api.pods.list.mockReturnValue(
			Effect.succeed(
				pods.map((pod) => ({
					...pod,
					permissions: { ...pod.permissions, manageRoutines: false, runRoutines: false },
				})),
			),
		);
		const { panel } = await openPanel(morningBrief);

		expect(within(panel).queryByRole("button", { name: "Run now" })).toBeNull();
		expect(within(panel).queryByRole("button", { name: /^More for / })).toBeNull();
		expect(screen.queryByRole("link", { name: "New routine" })).toBeNull();
		expect(within(panel).getByRole("switch", { name: "Routine on" })).toHaveProperty(
			"disabled",
			true,
		);

		expect(within(panel).getByText("Weekdays at 8:00")).toBeDefined();
		expect(within(panel).queryByRole("button", { name: /^Schedule/ })).toBeNull();
		expect(within(panel).queryByRole("button", { name: "Add trigger" })).toBeNull();
		expect(within(panel).getByText(morningBrief.routine.instructions)).toBeDefined();
		expect(within(panel).queryByRole("button", { name: "Edit instructions" })).toBeNull();
	});
});
