import type { Routine, RoutineExecution, WorkspaceRoutine } from "@sugabots/contracts";
import { InternalServerError } from "@sugabots/contracts/http";
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
		trigger: {
			kind: "cron",
			schedule: { repeat: "cron", expression },
			timezone: "UTC",
			nextScheduledAt: null,
		},
		state: "enabled",
		results: "keep_in_run",
		createdById: null,
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

describe("the workspace's routines", () => {
	it("lists every routine with when it runs and its bot, beside the first one", async () => {
		mount("/suga/settings/routines");

		const list = await screen.findByRole("navigation", { name: "Workspace routines" });
		expect(within(list).getByText(`Weekdays · 8:00, ${linear.name}`)).toBeDefined();
		expect(within(list).getByText(`Mon · 9:00, ${researcher.name}`)).toBeDefined();
		expect(within(list).getByText("Paused")).toBeDefined();
		expect(await screen.findByRole("heading", { name: "Morning brief" })).toBeDefined();
		const nav = screen.getByRole("navigation", { name: "Settings" });
		expect(within(nav).getByRole("link", { name: "Routines, 2" })).toBeDefined();
	});

	it("makes a routine for the bot chosen, then opens it", async () => {
		const timezone = Intl.DateTimeFormat().resolvedOptions().timeZone;
		client.api.routines.create.mockReturnValue(
			Effect.succeed({ routine: morningBrief.routine, secret: null }),
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
		fireEvent.click(screen.getByRole("radio", { name: "Weekly" }));
		fireEvent.click(screen.getByRole("checkbox", { name: "Thursday" }));
		fireEvent.click(screen.getByRole("button", { name: "30 minutes later" }));
		fireEvent.click(screen.getByRole("button", { name: "30 minutes later" }));
		expect(
			screen.getByText(
				new RegExp(
					`^Runs every week on Mon and Thu at 10:00, your time \\(.+\\) and posts the result in ${triager.name}'s chat in the ${suga.name} pod\\.$`,
				),
			),
		).toBeDefined();
		fireEvent.click(screen.getByRole("button", { name: "Create routine" }));

		await waitFor(() =>
			expect(client.api.routines.create).toHaveBeenCalledWith({
				params: { agentId: triager.id },
				payload: {
					name: "Triage sweep",
					instructions: "Sweep the queue.",
					results: "post_to_chat",
					trigger: {
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
				},
			}),
		);
		await waitFor(() => expect(router.state.location.pathname).toBe(routinePage(morningBrief)));
	});

	it("makes a routine that runs at several times on the last day of every third month", async () => {
		client.api.routines.create.mockReturnValue(
			Effect.succeed({ routine: morningBrief.routine, secret: null }),
		);
		mount("/suga/settings/routines/new");
		fireEvent.change(await screen.findByLabelText("Name"), { target: { value: "Quarter close" } });
		fireEvent.click(screen.getByRole("button", { name: /^Instructions/ }));
		fireEvent.change(await screen.findByLabelText("Instructions"), {
			target: { value: "Close the quarter." },
		});
		fireEvent.click(screen.getByRole("button", { name: "Done" }));
		fireEvent.click(screen.getByRole("radio", { name: "Monthly" }));
		while (screen.getByRole("status", { name: "On the" }).textContent !== "last day") {
			fireEvent.click(screen.getByRole("button", { name: "A day later" }));
		}
		fireEvent.click(screen.getByRole("button", { name: "Further apart" }));
		fireEvent.click(screen.getByRole("button", { name: "Further apart" }));
		fireEvent.click(screen.getByRole("button", { name: "+ Add a time" }));

		expect(screen.getByRole("status", { name: "Every" }).textContent).toBe("3 months");
		expect(
			screen.getByText(/^Runs every 3 months on the last day at 9:00 and 13:00, your time/),
		).toBeDefined();
		fireEvent.click(screen.getByRole("button", { name: "Create routine" }));

		await waitFor(() =>
			expect(client.api.routines.create).toHaveBeenCalledWith(
				expect.objectContaining({
					payload: expect.objectContaining({
						trigger: {
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

	it("shows a new webhook routine's secret on its page, once", async () => {
		const secret = "rtb_0123456789abcdef0123456789abcdef";
		const webhook: WorkspaceRoutine = {
			...morningBrief,
			routine: { ...morningBrief.routine, trigger: { kind: "webhook", auth: { kind: "bearer" } } },
		};
		client.api.routines.create.mockReturnValue(
			Effect.succeed({ routine: webhook.routine, secret }),
		);
		client.api.routines.listInWorkspace.mockReturnValue(Effect.succeed({ items: [webhook] }));
		mount("/suga/settings/routines/new");
		fireEvent.change(await screen.findByLabelText("Name"), { target: { value: "Sentry issues" } });
		fireEvent.click(screen.getByRole("button", { name: /^Instructions/ }));
		fireEvent.change(await screen.findByLabelText("Instructions"), {
			target: { value: "Fix what you can." },
		});
		fireEvent.click(screen.getByRole("button", { name: "Done" }));
		fireEvent.click(screen.getByRole("radio", { name: "Webhook" }));
		const posted = screen.getByRole("switch", { name: "Post result to chat" });
		expect(posted.getAttribute("aria-checked")).toBe("false");
		expect(screen.getByText(/keeps the result in the run/)).toBeDefined();
		fireEvent.click(screen.getByRole("button", { name: "Create routine" }));

		await waitFor(() =>
			expect(client.api.routines.create).toHaveBeenCalledWith(
				expect.objectContaining({
					payload: expect.objectContaining({
						trigger: {
							kind: "webhook",
							auth: { kind: "hmac", format: "body", header: "X-Signature", algorithm: "sha256" },
						},
						results: "keep_in_run",
					}),
				}),
			),
		);
		expect(
			await screen.findByText(new RegExp(`/hooks/routines/${webhook.routine.id}$`)),
		).toBeDefined();
		expect(screen.queryByText(secret)).toBeNull();
		fireEvent.click(screen.getByRole("button", { name: "Show" }));
		expect(screen.getByText(secret)).toBeDefined();
	});

	it("makes a webhook with the secret its sender made", async () => {
		client.api.routines.create.mockReturnValue(
			Effect.succeed({ routine: morningBrief.routine, secret: null }),
		);
		mount("/suga/settings/routines/new");
		fireEvent.change(await screen.findByLabelText("Name"), { target: { value: "Stripe events" } });
		fireEvent.click(screen.getByRole("button", { name: /^Instructions/ }));
		fireEvent.change(await screen.findByLabelText("Instructions"), {
			target: { value: "Reconcile the payment." },
		});
		fireEvent.click(screen.getByRole("button", { name: "Done" }));
		fireEvent.click(screen.getByRole("radio", { name: "Webhook" }));
		fireEvent.click(screen.getByRole("radio", { name: "Stripe" }));
		expect(screen.queryByLabelText("Header")).toBeNull();
		fireEvent.change(screen.getByLabelText("Secret"), { target: { value: "whsec_short" } });
		expect(screen.getByText("A pasted secret needs at least 16 characters.")).toBeDefined();
		expect(screen.getByRole("button", { name: "Create routine" })).toHaveProperty("disabled", true);
		fireEvent.change(screen.getByLabelText("Secret"), {
			target: { value: " whsec_0123456789abcdefghij " },
		});
		fireEvent.click(screen.getByRole("button", { name: "Create routine" }));

		await waitFor(() =>
			expect(client.api.routines.create).toHaveBeenCalledWith(
				expect.objectContaining({
					payload: expect.objectContaining({
						trigger: {
							kind: "webhook",
							auth: { kind: "hmac", format: "stripe" },
							secret: "whsec_0123456789abcdefghij",
						},
					}),
				}),
			),
		);
	});

	it("saves a webhook's auth as it changes, and shows a request that would run it", async () => {
		const webhook: WorkspaceRoutine = {
			...morningBrief,
			routine: {
				...morningBrief.routine,
				trigger: { kind: "webhook", auth: { kind: "api_key", header: "X-API-Key" } },
			},
		};
		client.api.routines.listInWorkspace.mockReturnValue(Effect.succeed({ items: [webhook] }));
		client.api.routines.update.mockReturnValue(
			Effect.succeed({ routine: webhook.routine, secret: null }),
		);
		mount(routinePage(webhook));

		expect(await screen.findByText(/-H "X-API-Key: \$API_KEY"/)).toBeDefined();
		expect(screen.getByText(/Send the key in the X-API-Key header\./)).toBeDefined();
		const header = screen.getByLabelText("Header");
		fireEvent.change(header, { target: { value: " X-Signup-Key " } });
		fireEvent.blur(header);
		await waitFor(() =>
			expect(client.api.routines.update).toHaveBeenCalledWith({
				params: { agentId: linear.id, routineId: webhook.routine.id },
				payload: {
					trigger: { kind: "webhook", auth: { kind: "api_key", header: "X-Signup-Key" } },
				},
			}),
		);

		fireEvent.click(screen.getByRole("radio", { name: "Basic" }));
		await waitFor(() =>
			expect(client.api.routines.update).toHaveBeenCalledWith({
				params: { agentId: linear.id, routineId: webhook.routine.id },
				payload: { trigger: { kind: "webhook", auth: { kind: "basic", username: "sugabots" } } },
			}),
		);
	});

	it("takes Slack's signing secret in place of the one it made", async () => {
		const slack: WorkspaceRoutine = {
			...morningBrief,
			routine: {
				...morningBrief.routine,
				trigger: { kind: "webhook", auth: { kind: "hmac", format: "slack" } },
			},
		};
		client.api.routines.listInWorkspace.mockReturnValue(Effect.succeed({ items: [slack] }));
		client.api.routines.rotateSecret.mockReturnValue(
			Effect.succeed({ secret: "8f742231b10e8888abcd99yyyzzz85a5" }),
		);
		mount(routinePage(slack));

		expect(await screen.findByText(/paste its Signing Secret here/)).toBeDefined();
		expect(screen.queryByText("Example request")).toBeNull();
		fireEvent.click(screen.getByRole("button", { name: "Paste" }));
		fireEvent.change(screen.getByLabelText("Sender's"), {
			target: { value: "8f742231b10e8888abcd99yyyzzz85a5" },
		});
		fireEvent.click(screen.getByRole("button", { name: "Save" }));

		await waitFor(() =>
			expect(client.api.routines.rotateSecret).toHaveBeenCalledWith({
				params: { agentId: linear.id, routineId: slack.routine.id },
				payload: { secret: "8f742231b10e8888abcd99yyyzzz85a5" },
			}),
		);
		expect(await screen.findByText(/^8f7422•+$/)).toBeDefined();
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
		expect(completed?.getAttribute("href")).toContain(
			"thread=0199a3a0-0000-7000-8000-000000000321",
		);
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
			return Effect.succeed({ routine: secondCopy.routine, secret: null });
		});
		const router = mount(routinePage(morningBrief));

		fireEvent.click(await screen.findByRole("button", { name: "Duplicate" }));

		await waitFor(() =>
			expect(client.api.routines.create).toHaveBeenCalledWith({
				params: { agentId: linear.id },
				payload: {
					name: "Morning brief copy 2",
					instructions: morningBrief.routine.instructions,
					results: morningBrief.routine.results,
					state: "paused",
					trigger: {
						kind: "cron",
						schedule: { repeat: "cron", expression: "0 8 * * 1-5" },
						timezone: "UTC",
					},
				},
			}),
		);
		await waitFor(() => expect(router.state.location.pathname).toBe(routinePage(secondCopy)));
	});

	it("turns a routine back on from its page", async () => {
		client.api.routines.update.mockReturnValue(
			Effect.succeed({ routine: { ...churnReport.routine, state: "enabled" }, secret: null }),
		);
		mount(routinePage(churnReport));

		expect(await screen.findByText("Paused. It only runs when you press Run now.")).toBeDefined();
		fireEvent.click(screen.getByRole("switch", { name: "Runs on its own" }));

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
			Effect.succeed({ routine: morningBrief.routine, secret: null }),
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

	it("saves a schedule once it rests", async () => {
		client.api.routines.update.mockReturnValue(
			Effect.succeed({ routine: morningBrief.routine, secret: null }),
		);
		mount(routinePage(morningBrief));

		fireEvent.click(await screen.findByRole("button", { name: "30 minutes later" }));
		fireEvent.click(screen.getByRole("button", { name: "30 minutes later" }));

		await waitFor(() =>
			expect(client.api.routines.update).toHaveBeenCalledWith({
				params: { agentId: linear.id, routineId: morningBrief.routine.id },
				payload: {
					trigger: {
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
				},
			}),
		);
		expect(client.api.routines.update).toHaveBeenCalledTimes(1);
	});

	it("keeps an unfamiliar schedule until a repeat replaces it", async () => {
		const hourly: WorkspaceRoutine = {
			...morningBrief,
			routine: {
				...morningBrief.routine,
				trigger: {
					kind: "cron",
					schedule: { repeat: "cron", expression: "15 */2 * * *" },
					timezone: "UTC",
					nextScheduledAt: null,
				},
			},
		};
		client.api.routines.listInWorkspace.mockReturnValue(Effect.succeed({ items: [hourly] }));
		client.api.routines.update.mockReturnValue(
			Effect.succeed({ routine: hourly.routine, secret: null }),
		);
		mount(routinePage(hourly));

		expect(await screen.findByText("15 */2 * * *")).toBeDefined();
		expect(screen.getByRole("radio", { name: "Daily" })).toHaveProperty("checked", false);
		fireEvent.click(screen.getByRole("radio", { name: "Daily" }));

		await waitFor(() =>
			expect(client.api.routines.update).toHaveBeenCalledWith({
				params: { agentId: linear.id, routineId: hourly.routine.id },
				payload: {
					trigger: {
						kind: "cron",
						schedule: { repeat: "daily", every: 1, times: [9 * 60], startsOn: today() },
						timezone: "UTC",
					},
				},
			}),
		);
	});

	it("says when a change or a secret reset fails", async () => {
		const webhook: WorkspaceRoutine = {
			...morningBrief,
			routine: { ...morningBrief.routine, trigger: { kind: "webhook", auth: { kind: "bearer" } } },
		};
		client.api.routines.listInWorkspace.mockReturnValue(Effect.succeed({ items: [webhook] }));
		client.api.routines.update.mockReturnValue(
			Effect.fail(new InternalServerError({ message: userText`Update unavailable` })),
		);
		client.api.routines.rotateSecret.mockReturnValue(
			Effect.fail(new InternalServerError({ message: userText`Rotation unavailable` })),
		);
		mount(routinePage(webhook));

		fireEvent.click(await screen.findByRole("switch", { name: "Runs on its own" }));
		expect((await screen.findByRole("alert")).textContent).toContain("Update unavailable");

		fireEvent.click(screen.getByRole("button", { name: "Make a new one" }));
		const confirm = await screen.findByRole("dialog", { name: "Make a new token?" });
		expect(client.api.routines.rotateSecret).not.toHaveBeenCalled();
		fireEvent.click(within(confirm).getByRole("button", { name: "Make a new one" }));
		await waitFor(() =>
			expect(within(confirm).getByRole("alert").textContent).toContain("Rotation unavailable"),
		);
	});

	it("deletes a routine after asking, then goes back to the list", async () => {
		client.api.routines.remove.mockReturnValue(Effect.void);
		const router = mount(routinePage(morningBrief));

		fireEvent.click(await screen.findByRole("button", { name: "Delete routine" }));
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
		expect(screen.getByRole("radio", { name: "Weekly" }).matches(":disabled")).toBe(true);
		expect(screen.queryByRole("button", { name: "Run now" })).toBeNull();
		expect(screen.queryByRole("button", { name: "Delete routine" })).toBeNull();
		expect(screen.queryByRole("button", { name: "New routine" })).toBeNull();

		fireEvent.click(screen.getByRole("button", { name: /^Instructions/ }));
		expect((await screen.findByLabelText("Instructions")).hasAttribute("readonly")).toBe(true);
		expect(screen.queryByRole("button", { name: "Save" })).toBeNull();
	});
});
