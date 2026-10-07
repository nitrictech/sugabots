import type { Routine, WorkspaceRoutine } from "@sugabots/contracts";
import { cleanup, fireEvent, screen, waitFor, within } from "@testing-library/react";
import { Effect } from "effect";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { agents, apiAnswers, linear, mount, pods, triager } from "@/test-api.tsx";
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
		trigger: { kind: "cron", expression, timezone: "UTC", nextScheduledAt: null },
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

describe("the workspace's routines", () => {
	it("lists every routine with when it runs and its bot, and whether it is on", async () => {
		mount("/suga/settings/routines");

		expect(await screen.findByText(`Weekdays at 8:00, ${linear.name}`)).toBeDefined();
		expect(screen.getByText(`Mondays at 9:00, ${researcher.name}`)).toBeDefined();
		expect(
			screen.getByRole("switch", { name: "Morning brief on" }).getAttribute("aria-checked"),
		).toBe("true");
		expect(
			screen.getByRole("switch", { name: "Weekly churn report on" }).getAttribute("aria-checked"),
		).toBe("false");
		const nav = screen.getByRole("navigation", { name: "Settings" });
		expect(within(nav).getByRole("link", { name: "Routines, 2" })).toBeDefined();
	});

	it("makes a routine for the bot chosen from the picker", async () => {
		client.api.routines.create.mockReturnValue(
			Effect.succeed({ routine: morningBrief.routine, secret: null }),
		);
		mount("/suga/settings/routines");
		fireEvent.click(await screen.findByRole("button", { name: "New routine" }));
		const form = await screen.findByRole("dialog", { name: "New routine" });
		fireEvent.change(within(form).getByLabelText("Name"), { target: { value: "Triage sweep" } });
		fireEvent.click(within(form).getByRole("button", { name: "Bot" }));

		const picker = await screen.findByRole("dialog", { name: "Bot" });
		expect(within(picker).getByRole("heading", { name: suga.name })).toBeDefined();
		expect(within(picker).getByRole("heading", { name: sales.name })).toBeDefined();
		fireEvent.click(within(picker).getByRole("button", { name: triager.name }));

		const back = await screen.findByRole("dialog", { name: "New routine" });
		fireEvent.click(within(back).getByRole("button", { name: "Instructions" }));
		const slide = await screen.findByRole("dialog", { name: "Instructions" });
		fireEvent.change(within(slide).getByLabelText("Instructions"), {
			target: { value: "Sweep the queue." },
		});
		fireEvent.click(within(slide).getByRole("button", { name: "Back" }));
		const ready = await screen.findByRole("dialog", { name: "New routine" });
		expect(
			within(ready).getByText(new RegExp(`in ${triager.name}'s chat in the ${suga.name} pod`)),
		).toBeDefined();
		fireEvent.click(within(ready).getByRole("button", { name: "Create" }));

		await waitFor(() =>
			expect(client.api.routines.create).toHaveBeenCalledWith(
				expect.objectContaining({
					params: { agentId: triager.id },
					payload: expect.objectContaining({ results: "post_to_chat" }),
				}),
			),
		);
	});

	it("keeps a webhook's result in the run until it is set to post to the chat", async () => {
		client.api.routines.create.mockReturnValue(
			Effect.succeed({ routine: morningBrief.routine, secret: null }),
		);
		mount("/suga/settings/routines");
		fireEvent.click(await screen.findByRole("button", { name: "New routine" }));
		const form = await screen.findByRole("dialog", { name: "New routine" });
		fireEvent.change(within(form).getByLabelText("Name"), { target: { value: "Sentry issues" } });
		fireEvent.click(within(form).getByRole("radio", { name: "Webhook" }));
		const posted = within(form).getByRole("switch", { name: "Post result to chat" });
		expect(posted.getAttribute("aria-checked")).toBe("false");
		expect(within(form).getByText(/keeps the result in the run/)).toBeDefined();

		fireEvent.click(posted);
		fireEvent.click(within(form).getByRole("button", { name: "Instructions" }));
		const slide = await screen.findByRole("dialog", { name: "Instructions" });
		fireEvent.change(within(slide).getByLabelText("Instructions"), {
			target: { value: "Fix what you can and tell us what you did." },
		});
		fireEvent.click(within(slide).getByRole("button", { name: "Back" }));
		const ready = await screen.findByRole("dialog", { name: "New routine" });
		expect(
			within(ready).getByText(/whenever the address is called .* and posts the result/),
		).toBeDefined();
		fireEvent.click(within(ready).getByRole("button", { name: "Create" }));

		await waitFor(() =>
			expect(client.api.routines.create).toHaveBeenCalledWith(
				expect.objectContaining({
					payload: expect.objectContaining({
						trigger: { kind: "webhook" },
						results: "post_to_chat",
					}),
				}),
			),
		);
	});

	it("turns a routine back on from its row", async () => {
		client.api.routines.update.mockReturnValue(
			Effect.succeed({ routine: { ...churnReport.routine, state: "enabled" }, secret: null }),
		);
		mount("/suga/settings/routines");

		fireEvent.click(await screen.findByRole("switch", { name: "Weekly churn report on" }));

		await waitFor(() =>
			expect(client.api.routines.update).toHaveBeenCalledWith({
				params: { agentId: researcher.id, routineId: churnReport.routine.id },
				payload: { state: "enabled" },
			}),
		);
	});

	it("runs a paused routine now from its row", async () => {
		client.api.routines.run.mockReturnValue(
			Effect.succeed({
				executionId: "0199a3a0-0000-7000-8000-0000000000e1",
				threadId: "0199a3a0-0000-7000-8000-0000000000e2",
				duplicate: false,
			}),
		);
		mount("/suga/settings/routines");

		fireEvent.click(await screen.findByRole("button", { name: "Run Weekly churn report now" }));

		await waitFor(() =>
			expect(client.api.routines.run).toHaveBeenCalledWith({
				params: { agentId: researcher.id, routineId: churnReport.routine.id },
				payload: { requestId: expect.any(String) },
			}),
		);
	});

	it("keeps an unfamiliar schedule until a repeat replaces it", async () => {
		const hourly: WorkspaceRoutine = {
			...morningBrief,
			routine: {
				...morningBrief.routine,
				trigger: {
					kind: "cron",
					expression: "15 */2 * * *",
					timezone: "UTC",
					nextScheduledAt: null,
				},
			},
		};
		client.api.routines.listInWorkspace.mockReturnValue(Effect.succeed({ items: [hourly] }));
		client.api.routines.update.mockReturnValue(
			Effect.succeed({ routine: hourly.routine, secret: null }),
		);
		mount("/suga/settings/routines");

		fireEvent.click(await screen.findByRole("button", { name: /^Morning brief/ }));
		const dialog = await screen.findByRole("dialog", { name: "Edit routine" });
		expect(within(dialog).getByText("15 */2 * * *")).toBeDefined();
		expect(within(dialog).getByRole("radio", { name: "Every day" })).toHaveProperty(
			"checked",
			false,
		);
		fireEvent.click(within(dialog).getByRole("button", { name: "Save" }));

		await waitFor(() =>
			expect(client.api.routines.update).toHaveBeenCalledWith(
				expect.objectContaining({
					payload: expect.objectContaining({
						trigger: { kind: "cron", expression: "15 */2 * * *", timezone: "UTC" },
					}),
				}),
			),
		);
	});
});
