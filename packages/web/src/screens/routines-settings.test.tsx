import type { Routine, RoutineExecution, WorkspaceRoutine } from "@sugabots/contracts";
import { InternalServerError } from "@sugabots/contracts/http";
import { routineTriggers, type TestRoutineTrigger } from "@sugabots/contracts/testing";
import { userText } from "@sugabots/errors";
import { cleanup, fireEvent, screen, waitFor, within } from "@testing-library/react";
import { Effect } from "effect";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { today } from "@/lib/routine-schedule.ts";
import { agents, apiAnswers, jye, linear, mount, pods, sam, triager } from "@/test-api.tsx";
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

const routinePage = (one: WorkspaceRoutine) => `/suga/settings/routines/${one.routine.id}`;

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
function pickTime(chip: number, minutesPastMidnight: number) {
	fireEvent.change(screen.getByRole("combobox", { name: `Time ${chip}` }), {
		target: { value: String(minutesPastMidnight) },
	});
}

describe("the workspace's routines", () => {
	it("lists every routine with when it runs and its bot, beside the first one", async () => {
		mount("/suga/settings/routines");

		const list = await screen.findByRole("navigation", { name: "Workspace routines" });
		expect(within(list).getByText(`Weekdays at 8:00, ${linear.name}`)).toBeDefined();
		expect(within(list).getByText(`Mon at 9:00, ${researcher.name}`)).toBeDefined();
		expect(within(list).getByText("Paused")).toBeDefined();
		expect(await screen.findByRole("heading", { name: "Morning brief" })).toBeDefined();
		const nav = screen.getByRole("navigation", { name: "Settings" });
		expect(within(nav).getByRole("link", { name: "Routines, 2" })).toBeDefined();
	});

	it("makes a routine for the bot chosen, then opens it", async () => {
		const timezone = Intl.DateTimeFormat().resolvedOptions().timeZone;
		client.api.routines.create.mockReturnValue(
			Effect.succeed({ routine: morningBrief.routine, secrets: [] }),
		);
		const router = mount("/suga/settings/routines/new");
		fireEvent.change(await screen.findByLabelText("Name"), { target: { value: "Triage sweep" } });
		fireEvent.click(screen.getByRole("button", { name: /^Bot/ }));
		expect(screen.getByRole("heading", { name: suga.name })).toBeDefined();
		expect(screen.getByRole("heading", { name: sales.name })).toBeDefined();
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
		pickTime(1, 10 * 60);
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
		await waitFor(() => expect(router.state.location.pathname).toBe(routinePage(morningBrief)));
	});

	it("makes a routine that runs at several times on the last day of every third month", async () => {
		client.api.routines.create.mockReturnValue(
			Effect.succeed({ routine: morningBrief.routine, secrets: [] }),
		);
		mount("/suga/settings/routines/new");
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

	it("starts a routine made from a bot's settings on that bot", async () => {
		mount(`/suga/settings/routines/new?agent=${researcher.id}`);

		const bot = await screen.findByRole("button", { name: /^Bot/ });
		expect(within(bot).getByText(researcher.name)).toBeDefined();
	});

	it("makes a webhook with the secret typed for it, which its page shows", async () => {
		const webhook = withTrigger(morningBrief, {
			kind: "webhook",
			auth: { kind: "hmac", header: "X-Signature", algorithm: "sha256", encoding: "hex" },
		});
		client.api.routines.create.mockReturnValue(
			Effect.succeed({ routine: webhook.routine, secrets: [] }),
		);
		client.api.routines.listInWorkspace.mockReturnValue(Effect.succeed({ items: [webhook] }));
		mount("/suga/settings/routines/new");
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
		const posted = screen.getByRole("switch", { name: "Post result to chat" });
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
		await openTrigger(/^Webhook/);
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
		mount("/suga/settings/routines/new");
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
		mount(routinePage(webhook));
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

	it("saves the header a webhook's delivery id is read from, and none when it is cleared", async () => {
		const webhook = withTrigger(morningBrief, { kind: "webhook", auth: { kind: "bearer" } });
		client.api.routines.listInWorkspace.mockReturnValue(Effect.succeed({ items: [webhook] }));
		client.api.routines.updateTrigger.mockReturnValue(
			Effect.succeed({ routine: webhook.routine, secrets: [] }),
		);
		mount(routinePage(webhook));
		await openTrigger(/^Webhook/);

		// A webhook made before the header could be set reads Idempotency-Key.
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
		mount(routinePage(webhook));
		await openTrigger(/^Webhook/);

		expect(await screen.findByRole("button", { name: "Source: GitHub" })).toBeDefined();
		expect(screen.queryByLabelText("Delivery ID header")).toBeNull();
	});

	it("leaves a webhook without a secret when its secret is cleared", async () => {
		const webhook = withTrigger(morningBrief, {
			kind: "webhook",
			auth: { kind: "hmac", header: "X-Signature", algorithm: "sha256", encoding: "hex" },
		});
		client.api.routines.listInWorkspace.mockReturnValue(Effect.succeed({ items: [webhook] }));
		client.api.routines.rotateSecret.mockReturnValue(Effect.succeed({ secret: null }));
		mount(routinePage(webhook));
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
		mount(routinePage(slack));
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
		mount(routinePage(webhook));
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

	it("shows a routine's latest runs: how each went, what started it, and how long it took", async () => {
		const at = (secondsAgo: number) => new Date(Date.now() - secondsAgo * 1000).toISOString();
		const run = (
			n: number,
			fields: Pick<RoutineExecution, "trigger" | "state"> & Partial<RoutineExecution>,
		): RoutineExecution => ({
			id: `0199a3a0-0000-7000-8000-0000000003${n}0`,
			routineId: morningBrief.routine.id,
			workspaceId: linear.workspaceId,
			agentId: linear.id,
			threadId: `0199a3a0-0000-7000-8000-0000000003${n}1`,
			routineName: "Morning brief",
			instructions: "Brief us.",
			error: null,
			acceptedAt: at(60 * n),
			startedAt: at(60 * n),
			finishedAt: null,
			...fields,
		});
		const manual = (userId: string) => ({
			kind: "manual" as const,
			requestedAt: at(0),
			requestedByUserId: userId,
			requestId: "0199a3a0-0000-7000-8000-0000000003ff",
		});
		client.api.routines.executions.mockReturnValue(
			Effect.succeed({
				items: [
					run(1, { trigger: manual(sam.id), state: "running" }),
					run(2, {
						trigger: manual(jye.id),
						state: "completed",
						startedAt: at(120),
						finishedAt: at(106),
					}),
					run(3, {
						trigger: { kind: "cron", scheduledAt: at(180), acceptedAt: at(180) },
						state: "failed",
						error: "HubSpot timed out",
						finishedAt: at(170),
					}),
				],
				nextCursor: null,
			}),
		);
		mount(routinePage(morningBrief));

		const runs = await screen.findByRole("region", { name: "Recent runs" });
		const [running, completed, failed] = within(runs).getAllByRole("link");
		expect(within(running as HTMLElement).getByText("Run by you")).toBeDefined();
		expect(within(running as HTMLElement).getByText("Running…")).toBeDefined();
		expect(within(running as HTMLElement).getByText(/^Today, /)).toBeDefined();
		expect(within(completed as HTMLElement).getByText("Run by Jye")).toBeDefined();
		expect(within(completed as HTMLElement).getByText("14s")).toBeDefined();
		expect(within(failed as HTMLElement).getByText("HubSpot timed out")).toBeDefined();
		expect(within(failed as HTMLElement).getByRole("img", { name: "Failed" })).toBeDefined();
		const href = completed?.getAttribute("href") ?? "";
		expect(href).toContain("/suga/activity/");
		expect(href).toContain("threadPage=0199a3a0-0000-7000-8000-000000000321");
		expect(client.api.routines.executions).toHaveBeenCalledWith(
			expect.objectContaining({
				params: { agentId: linear.id, routineId: morningBrief.routine.id },
				query: { limit: 5 },
			}),
		);
	});

	it("says a routine that has never run can be tried with Run now", async () => {
		mount(routinePage(morningBrief));

		expect(await screen.findByText("No runs yet. Run now to try it.")).toBeDefined();
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
		let items = [morningBrief, firstCopy];
		client.api.routines.listInWorkspace.mockImplementation(() => Effect.succeed({ items }));
		client.api.routines.create.mockImplementation(() => {
			items = [...items, secondCopy];
			return Effect.succeed({ routine: secondCopy.routine, secrets: [] });
		});
		const router = mount(routinePage(morningBrief));

		fireEvent.click(await screen.findByRole("button", { name: "More" }));
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
		await waitFor(() => expect(router.state.location.pathname).toBe(routinePage(secondCopy)));
	});

	it("turns a routine back on from its page", async () => {
		client.api.routines.update.mockReturnValue(
			Effect.succeed({ routine: { ...churnReport.routine, state: "enabled" }, secrets: [] }),
		);
		mount(routinePage(churnReport));

		const on = await screen.findByRole("switch", { name: "On" });
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
		mount(routinePage(churnReport));

		fireEvent.click(await screen.findByRole("button", { name: "Run now" }));

		await waitFor(() =>
			expect(client.api.routines.run).toHaveBeenCalledWith({
				params: { agentId: researcher.id, routineId: churnReport.routine.id },
				payload: { requestId: expect.any(String) },
			}),
		);
	});

	it("saves instructions from their own page, then goes back to the routine", async () => {
		client.api.routines.update.mockReturnValue(
			Effect.succeed({ routine: morningBrief.routine, secrets: [] }),
		);
		mount(routinePage(morningBrief));
		fireEvent.click(await screen.findByRole("button", { name: /^Instructions/ }));
		const instructions = await screen.findByLabelText("Instructions");
		expect(screen.getByRole("button", { name: "Save" })).toHaveProperty("disabled", true);
		fireEvent.change(instructions, { target: { value: "  Brief the team.  " } });
		fireEvent.click(screen.getByRole("button", { name: "Save" }));

		await waitFor(() =>
			expect(client.api.routines.update).toHaveBeenCalledWith({
				params: { agentId: linear.id, routineId: morningBrief.routine.id },
				payload: { instructions: "Brief the team." },
			}),
		);
		fireEvent.click(screen.getByRole("button", { name: "Morning brief" }));
		expect(await screen.findByRole("heading", { name: "Morning brief" })).toBeDefined();
	});

	it("saves a schedule's change once it is saved, then closes", async () => {
		client.api.routines.updateTrigger.mockReturnValue(
			Effect.succeed({ routine: morningBrief.routine, secrets: [] }),
		);
		mount(routinePage(morningBrief));
		const schedule = await openTrigger(/^Weekdays at 8:00/);

		pickTime(1, 8 * 60 + 30);
		pickTime(1, 9 * 60);
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
		mount(routinePage(morningBrief));

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

		const schedule = await openTrigger(/^Weekdays at 8:00/);
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
		mount(routinePage(hourly));
		const schedule = await openTrigger(/Schedule$/);

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
		client.api.routines.listInWorkspace.mockReturnValue(Effect.succeed({ items: [webhook] }));
		client.api.routines.update.mockReturnValue(
			Effect.fail(new InternalServerError({ message: userText`Update unavailable` })),
		);
		client.api.routines.rotateSecret.mockReturnValue(
			Effect.fail(new InternalServerError({ message: userText`Rotation unavailable` })),
		);
		mount(routinePage(webhook));

		fireEvent.click(await screen.findByRole("switch", { name: "On" }));
		expect((await screen.findByRole("alert")).textContent).toContain("Update unavailable");

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

	it("deletes a routine after asking, then goes back to the list", async () => {
		client.api.routines.remove.mockReturnValue(Effect.void);
		const router = mount(routinePage(morningBrief));

		fireEvent.click(await screen.findByRole("button", { name: "More" }));
		fireEvent.click(await screen.findByRole("menuitem", { name: "Delete routine" }));
		const confirm = await screen.findByRole("dialog", { name: "Delete Morning brief?" });
		expect(client.api.routines.remove).not.toHaveBeenCalled();
		fireEvent.click(within(confirm).getByRole("button", { name: "Delete" }));

		await waitFor(() =>
			expect(client.api.routines.remove).toHaveBeenCalledWith({
				params: { agentId: linear.id, routineId: morningBrief.routine.id },
			}),
		);
		await waitFor(() => expect(router.state.location.pathname).toBe("/suga/settings/routines"));
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
		mount(routinePage(morningBrief));

		expect(await screen.findByRole("heading", { name: "Morning brief" })).toBeDefined();
		expect(screen.queryByRole("button", { name: "Run now" })).toBeNull();
		expect(screen.queryByRole("button", { name: "More" })).toBeNull();
		expect(screen.queryByRole("button", { name: "New routine" })).toBeNull();

		expect(screen.getByText("Weekdays at 8:00")).toBeDefined();
		expect(screen.queryByRole("button", { name: /^Weekdays at 8:00/ })).toBeNull();
		expect(screen.queryByRole("button", { name: "Add trigger" })).toBeNull();

		fireEvent.click(screen.getByRole("button", { name: /^Instructions/ }));
		expect((await screen.findByLabelText("Instructions")).hasAttribute("readonly")).toBe(true);
		expect(screen.queryByRole("button", { name: "Save" })).toBeNull();
	});
});
