import type { Connection, Routine } from "@sugabots/contracts";
import { Conflict, InternalServerError } from "@sugabots/contracts/http";
import { cleanup, fireEvent, screen, waitFor, within } from "@testing-library/react";
import { Effect } from "effect";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
	agents,
	apiAnswers,
	builtInAgents,
	facilitator,
	linear,
	MODELS,
	mount,
	open,
	pendingAnswer,
	pods,
	triager,
	workspace,
} from "@/test-api.tsx";
import { client } from "@/test-client.ts";

vi.mock("@/api.ts", () => import("@/test-client.ts"));

const page = `/settings/pods/${linear.podId}/agents/${linear.id}`;
const suga = pods[0] as (typeof pods)[number];
const webhookRoutine = {
	id: "0199a3a0-0000-7000-8000-0000000000a1",
	workspaceId: linear.workspaceId,
	agentId: linear.id,
	name: "Triage intake",
	instructions: "Triage the request.",
	trigger: { kind: "webhook" },
	state: "enabled",
	createdById: null,
	createdAt: "2026-09-18T00:00:00.000Z",
	updatedAt: "2026-09-18T00:00:00.000Z",
} satisfies Routine;
const scheduledRoutine = {
	...webhookRoutine,
	name: "Morning brief",
	trigger: {
		kind: "cron",
		expression: "0 9 * * 1-5",
		timezone: "America/Los_Angeles",
		nextScheduledAt: "2026-09-21T09:00:00.000Z",
	},
} satisfies Routine;

beforeEach(apiAnswers);

afterEach(() => {
	cleanup();
	vi.clearAllMocks();
});

function answers(change: Partial<typeof linear>): void {
	client.api.agents.update.mockReturnValue(Effect.succeed({ ...linear, ...change }));
}

function rosterAnswers(change: Partial<typeof linear>): void {
	answers(change);
	client.api.agents.list.mockReturnValue(
		Effect.succeed(agents.map((one) => (one.id === linear.id ? { ...one, ...change } : one))),
	);
}

async function showTab(name: "Details" | "Prompt" | "Tools" | "Routines") {
	fireEvent.click(await screen.findByRole("tab", { name }));
}

describe("what everybody sees", () => {
	it("links back to Pods from the pod breadcrumb", async () => {
		const router = mount(page);
		const breadcrumb = await screen.findByRole("navigation", { name: "Breadcrumb" });

		expect(await within(breadcrumb).findByRole("heading", { name: suga.name })).toBeDefined();
		fireEvent.click(within(breadcrumb).getByRole("link", { name: "Pods" }));
		await waitFor(() => expect(router.state.location.pathname).toBe("/settings/pods"));
	});

	it("keeps thread creation out of workspace settings", async () => {
		mount(page);
		await showTab("Tools");

		expect(await screen.findByText("Read web pages")).toBeDefined();
		expect(screen.getByText("Search the web")).toBeDefined();
		expect(screen.queryByRole("button", { name: "New thread" })).toBeNull();
		expect(screen.queryByText("Conversation history")).toBeNull();
	});

	it("shows the other agents owned by the same pod", async () => {
		mount(page);
		const rail = await screen.findByRole("navigation", { name: "Suga-Team agents" });
		expect(within(rail).getByRole("link", { name: "Back to pods" }).getAttribute("href")).toBe(
			"/settings/pods",
		);
		await within(rail).findByText(triager.name);
		expect(within(rail).getByText(linear.name)).toBeDefined();
		// A built-in agent is in no pod, so the pod's rail has nothing to say
		// about it and needs no heading to separate it out.
		expect(within(rail).queryByText(facilitator.name)).toBeNull();
		expect(within(rail).queryByText("User agents")).toBeNull();
	});
});

describe("a member", () => {
	beforeEach(() => {
		apiAnswers({ role: "member" });
	});

	it("edits the model and the prompt, which a member of the pod may do", async () => {
		mount(page);

		expect(await screen.findByRole("combobox", { name: "Model" })).toBeDefined();
		await showTab("Prompt");
		expect(await screen.findByLabelText("System prompt")).toBeDefined();
	});

	function linearConnection(over: Partial<Connection> = {}): Connection {
		return {
			id: "0199a3a0-0000-7000-8000-0000000000f1",
			workspaceId: linear.workspaceId,
			podId: linear.podId,
			name: "Linear",
			handle: "linear",
			url: "https://mcp.linear.app/mcp",
			auth: "oauth",
			signedIn: true,
			secretHeader: null,
			hasSecret: false,
			enabled: true,
			allowMutating: false,
			status: "connected",
			tools: [
				{ name: "list_issues", description: "List issues", readOnly: true, destructive: false },
			],
			lastTestedAt: "2026-09-19T00:00:00.000Z",
			lastTestError: null,
			createdAt: "2026-09-19T00:00:00.000Z",
			...over,
		};
	}

	/** A read, an additive change, and an overwriting one, as Linear describes them. */
	const readsAndWrites: Connection["tools"] = [
		{ name: "list_issues", description: "List issues", readOnly: true, destructive: false },
		{ name: "create_issue_label", description: null, readOnly: false, destructive: false },
		{ name: "save_issue", description: null, readOnly: false, destructive: true },
	];

	it("lists the enabled connections inherited from the pod", async () => {
		client.api.connections.list.mockReturnValue(Effect.succeed([linearConnection()]));
		mount(page);
		await showTab("Tools");

		expect(await screen.findByText("Linear")).toBeDefined();
		expect(screen.getByText("1 tool")).toBeDefined();
		expect(screen.getByRole("link", { name: "View pod connections" })).toBeDefined();
	});

	it("shows every change a read-only connection offers as not available to the agent", async () => {
		client.api.connections.list.mockReturnValue(
			Effect.succeed([linearConnection({ tools: readsAndWrites })]),
		);
		mount(page);
		await showTab("Tools");

		fireEvent.click(
			await screen.findByRole("button", { name: /Linear.*1 tool · 2 not available/ }),
		);

		const tools = await screen.findByRole("dialog", { name: "Linear tools" });
		const free = within(tools).getByRole("region", { name: "Runs freely" });
		expect(within(free).getByText("List Issues")).toBeDefined();
		const unavailable = within(tools).getByRole("region", { name: "Not available" });
		expect(within(unavailable).getByText("Create Issue Label")).toBeDefined();
		expect(within(unavailable).getByText("Save Issue")).toBeDefined();
	});

	it("says which changes ask first and which this agent may always make", async () => {
		const connection = linearConnection({ tools: readsAndWrites, allowMutating: true });
		client.api.connections.list.mockReturnValue(Effect.succeed([connection]));
		client.api.toolApprovals.listRules.mockReturnValue(
			Effect.succeed([
				{
					id: "0199a3a0-0000-7000-8000-0000000000f2",
					agentId: linear.id,
					agentName: linear.name,
					connectionId: connection.id,
					connectionName: connection.name,
					toolName: "save_issue",
					createdAt: "2026-09-19T00:00:00.000Z",
				},
			]),
		);
		mount(page);
		await showTab("Tools");

		fireEvent.click(await screen.findByRole("button", { name: /Linear.*3 tools/ }));

		const tools = await screen.findByRole("dialog", { name: "Linear tools" });
		const asks = within(tools).getByRole("region", { name: "Asks first" });
		expect(within(asks).getByText("Create Issue Label")).toBeDefined();
		await waitFor(() =>
			expect(
				within(within(tools).getByRole("region", { name: "Always allowed" })).getByText(
					"Save Issue",
				),
			).toBeDefined(),
		);
		expect(within(tools).queryByRole("region", { name: "Not available" })).toBeNull();
	});

	it("is offered renaming but not deleting", async () => {
		mount(page);

		expect(await screen.findByRole("navigation", { name: `${suga.name} agents` })).toBeDefined();
		open(await screen.findByRole("button", { name: `${linear.name} options` }));

		expect(await screen.findByRole("menuitem", { name: "Rename" })).toBeDefined();
		expect(screen.queryByRole("menuitem", { name: "Delete agent" })).toBeNull();
	});
});

describe("a viewer", () => {
	beforeEach(() => {
		apiAnswers({ role: "viewer" });
	});

	it("reads the model and the prompt rather than editing them", async () => {
		mount(page);

		expect(await screen.findByText(MODELS[0] as string)).toBeDefined();
		expect(screen.queryByRole("combobox", { name: "Model" })).toBeNull();
		await showTab("Prompt");
		expect(await screen.findByText("Be brief.")).toBeDefined();
		expect(screen.queryByLabelText("System prompt")).toBeNull();
	});

	it("is offered no way to rename or delete the agent", async () => {
		mount(page);

		await screen.findByRole("navigation", { name: `${suga.name} agents` });
		expect(screen.queryByRole("button", { name: `${linear.name} options` })).toBeNull();
	});
});

describe("an admin", () => {
	it("opens a directly linked Routine definition on the Routines tab", async () => {
		mount(`${page}?tab=routines`);

		const tab = await screen.findByRole("tab", { name: "Routines" });
		expect(tab.getAttribute("aria-selected")).toBe("true");
		expect(await screen.findByRole("button", { name: "New routine" })).toBeDefined();
	});

	it("previews the next Routine run as the schedule changes", async () => {
		client.api.routines.previewSchedule.mockReturnValue(
			Effect.succeed([
				"2026-09-21T09:00:00.000Z",
				"2026-09-22T09:00:00.000Z",
				"2026-09-23T09:00:00.000Z",
			]),
		);
		mount(page);
		await showTab("Routines");
		fireEvent.click(await screen.findByRole("button", { name: "New routine" }));
		const timezone = Intl.DateTimeFormat().resolvedOptions().timeZone;

		await waitFor(() => {
			expect(client.api.routines.previewSchedule).toHaveBeenCalledWith({
				params: { agentId: linear.id },
				payload: { expression: "0 9 * * 1-5", timezone },
			});
		});
		const dialog = await screen.findByRole("dialog", { name: "New routine" });
		expect(
			within(dialog).getByText(
				`Next run ${new Intl.DateTimeFormat(undefined, {
					day: "numeric",
					month: "short",
					hour: "numeric",
					minute: "2-digit",
					timeZone: timezone,
				}).format(new Date("2026-09-21T09:00:00.000Z"))}`,
			),
		).toBeDefined();

		fireEvent.click(within(dialog).getByRole("button", { name: "Every day" }));
		await waitFor(() => {
			expect(client.api.routines.previewSchedule).toHaveBeenCalledWith({
				params: { agentId: linear.id },
				payload: { expression: "0 9 * * *", timezone },
			});
		});
	});

	it("saves schedule presets as cron in the detected timezone", async () => {
		const timezone = Intl.DateTimeFormat().resolvedOptions().timeZone;
		client.api.routines.create.mockReturnValue(
			Effect.succeed({
				routine: {
					...scheduledRoutine,
					trigger: {
						kind: "cron",
						expression: "30 17 * * *",
						timezone,
						nextScheduledAt: "2026-09-18T17:30:00.000Z",
					},
				},
				secret: null,
			}),
		);
		mount(page);
		await showTab("Routines");
		fireEvent.click(await screen.findByRole("button", { name: "New routine" }));
		const dialog = await screen.findByRole("dialog", { name: "New routine" });
		fireEvent.change(within(dialog).getByLabelText("Name"), {
			target: { value: "Evening review" },
		});
		fireEvent.change(within(dialog).getByLabelText("Instructions"), {
			target: { value: "Review the day." },
		});
		fireEvent.click(within(dialog).getByRole("button", { name: "Every day" }));
		fireEvent.change(within(dialog).getByLabelText("Run time"), {
			target: { value: "17:30" },
		});
		fireEvent.click(within(dialog).getByRole("button", { name: "Save routine" }));

		await waitFor(() => {
			expect(client.api.routines.create).toHaveBeenCalledWith({
				params: { agentId: linear.id },
				payload: {
					name: "Evening review",
					instructions: "Review the day.",
					state: "enabled",
					trigger: { kind: "cron", expression: "30 17 * * *", timezone },
				},
			});
		});
	});

	it("shows scheduled Routines in plain language", async () => {
		client.api.routines.list.mockReturnValue(Effect.succeed([scheduledRoutine]));
		client.api.routines.executions.mockReturnValue(Effect.succeed({ items: [], nextCursor: null }));
		mount(page);
		await showTab("Routines");

		const expected = new Intl.DateTimeFormat(undefined, {
			day: "numeric",
			month: "short",
			hour: "numeric",
			minute: "2-digit",
			timeZone: scheduledRoutine.trigger.timezone,
		}).format(new Date(scheduledRoutine.trigger.nextScheduledAt));
		expect(await screen.findByText("Every weekday at 9:00 am")).toBeDefined();
		expect(await screen.findByText(`Next ${expected}`)).toBeDefined();
		expect(screen.queryByText(scheduledRoutine.trigger.expression)).toBeNull();
	});

	it("shows Routine action failures on the affected row", async () => {
		client.api.routines.list.mockReturnValue(Effect.succeed([webhookRoutine]));
		client.api.routines.executions.mockReturnValue(Effect.succeed({ items: [], nextCursor: null }));
		client.api.routines.run.mockReturnValue(
			Effect.fail(new InternalServerError({ message: "Run unavailable" })),
		);
		client.api.routines.update.mockReturnValue(
			Effect.fail(new InternalServerError({ message: "Update unavailable" })),
		);
		client.api.routines.rotateSecret.mockReturnValue(
			Effect.fail(new InternalServerError({ message: "Rotation unavailable" })),
		);
		mount(page);
		await showTab("Routines");

		fireEvent.click(await screen.findByRole("button", { name: "Run now" }));
		expect((await screen.findByRole("alert")).textContent).toContain("Run unavailable");

		open(screen.getByRole("button", { name: `${webhookRoutine.name} options` }));
		fireEvent.click(await screen.findByRole("menuitem", { name: "Pause" }));
		await waitFor(() =>
			expect(screen.getByRole("alert").textContent).toContain("Update unavailable"),
		);

		open(screen.getByRole("button", { name: `${webhookRoutine.name} options` }));
		fireEvent.click(await screen.findByRole("menuitem", { name: "Edit" }));
		const dialog = await screen.findByRole("dialog", { name: "Edit routine" });
		const reset = within(dialog).getByRole("button", { name: "Reset" });
		expect(reset.hasAttribute("disabled")).toBe(true);
		fireEvent.change(within(dialog).getByLabelText("Confirm secret reset"), {
			target: { value: webhookRoutine.name.toLocaleUpperCase() },
		});
		expect(reset.hasAttribute("disabled")).toBe(false);
		fireEvent.click(reset);
		await waitFor(() =>
			expect(within(dialog).getByRole("alert").textContent).toContain("Rotation unavailable"),
		);
		expect(screen.queryByRole("dialog", { name: "Webhook credential" })).toBeNull();
	});

	it("discards the previous agent's draft when navigating to another agent", async () => {
		const router = mount(page);
		await showTab("Prompt");
		fireEvent.change(await screen.findByLabelText("System prompt"), {
			target: { value: "Private draft" },
		});

		await router.navigate({
			to: "/settings/pods/$pod/agents/$agent",
			params: { pod: triager.podId, agent: triager.id },
		});

		await waitFor(() => expect(screen.queryByLabelText("System prompt")).toBeNull());
		expect(client.api.agents.update).not.toHaveBeenCalled();
	});

	it("renames the agent from its menu", async () => {
		const renamed = { ...linear, name: "Linear Steward" };
		answers({ name: renamed.name });
		mount(page);

		open(await screen.findByRole("button", { name: `${linear.name} options` }));
		fireEvent.click(await screen.findByRole("menuitem", { name: "Rename" }));
		fireEvent.change(await screen.findByLabelText("Name"), {
			target: { value: `  ${renamed.name}  ` },
		});
		client.api.agents.list.mockReturnValue(
			Effect.succeed(agents.map((agent) => (agent.id === linear.id ? renamed : agent))),
		);
		fireEvent.click(await screen.findByRole("button", { name: "Save name" }));

		await waitFor(() => {
			expect(client.api.agents.update).toHaveBeenCalledWith({
				params: { agentId: linear.id },
				payload: { name: renamed.name },
			});
		});
		expect((await screen.findAllByText(renamed.name)).length).toBeGreaterThan(0);
		expect(screen.queryByLabelText("Name")).toBeNull();
	});

	it("keeps a rejected rename open with the entered name", async () => {
		client.api.agents.update.mockReturnValue(
			Effect.fail(new Conflict({ message: "An agent with that name already exists" })),
		);
		mount(page);

		open(await screen.findByRole("button", { name: `${linear.name} options` }));
		fireEvent.click(await screen.findByRole("menuitem", { name: "Rename" }));
		fireEvent.change(await screen.findByLabelText("Name"), {
			target: { value: triager.name },
		});
		fireEvent.click(await screen.findByRole("button", { name: "Save name" }));

		expect(await screen.findByRole("alert")).toBeDefined();
		expect((screen.getByLabelText("Name") as HTMLInputElement).value).toBe(triager.name);
	});

	it("writes the description when you leave the field", async () => {
		answers({ description: "Digs through calls." });
		mount(page);

		const description = await screen.findByLabelText("Description");
		fireEvent.change(description, { target: { value: "Digs through calls." } });
		fireEvent.blur(description);

		await waitFor(() => {
			expect(client.api.agents.update).toHaveBeenCalledWith({
				params: { agentId: linear.id },
				payload: { description: "Digs through calls." },
			});
		});
	});

	it("does not write a description that did not change", async () => {
		mount(page);

		fireEvent.blur(await screen.findByLabelText("Description"));

		expect(client.api.agents.update).not.toHaveBeenCalled();
	});

	it("writes the description once while a save is pending", async () => {
		const update = pendingAnswer();
		client.api.agents.update.mockReturnValue(update.effect);
		mount(page);
		const description = await screen.findByLabelText("Description");
		fireEvent.change(description, { target: { value: "Pending description" } });
		fireEvent.blur(description);
		await waitFor(() => expect(client.api.agents.update).toHaveBeenCalledOnce());

		fireEvent.blur(description);
		expect(client.api.agents.update).toHaveBeenCalledOnce();

		update.answer(Effect.fail(new InternalServerError({ message: "Unavailable" })));
		expect(await screen.findByRole("alert")).toBeDefined();
		expect((description as HTMLInputElement).value).toBe("Pending description");
	});

	it("says so when the API refuses a change, rather than losing it silently", async () => {
		client.api.agents.update.mockReturnValue(
			Effect.fail(new Conflict({ message: "An agent called that already exists" })),
		);
		mount(page);

		const description = await screen.findByLabelText("Description");
		fireEvent.change(description, { target: { value: "Nope." } });
		fireEvent.blur(description);

		expect(await screen.findByRole("alert")).toBeDefined();
		expect((description as HTMLInputElement).value).toBe("Nope.");
	});

	it("cannot save a prompt that has not changed", async () => {
		mount(page);
		await showTab("Prompt");

		const save = await screen.findByRole("button", { name: "Save" });
		expect((save as HTMLButtonElement).disabled).toBe(true);
		expect((screen.getByRole("button", { name: "Revert" }) as HTMLButtonElement).disabled).toBe(
			true,
		);
	});

	it("puts a part-written prompt back on Revert without writing", async () => {
		mount(page);
		await showTab("Prompt");

		const prompt = await screen.findByLabelText("System prompt");
		fireEvent.change(prompt, { target: { value: "Be terse." } });
		fireEvent.click(screen.getByRole("button", { name: "Revert" }));

		expect((prompt as HTMLTextAreaElement).value).toBe("Be brief.");
		expect(client.api.agents.update).not.toHaveBeenCalled();
	});

	it("counts the prompt against its limit", async () => {
		mount(page);
		await showTab("Prompt");

		expect(await screen.findByText("9 / 20,000")).toBeDefined();
		fireEvent.change(screen.getByLabelText("System prompt"), {
			target: { value: "Be terse." },
		});
		expect(screen.getByText("9 / 20,000")).toBeDefined();
	});

	it("saves the prompt", async () => {
		mount(page);
		await showTab("Prompt");

		fireEvent.change(await screen.findByLabelText("System prompt"), {
			target: { value: "Be terse." },
		});
		rosterAnswers({ prompt: "Be terse." });
		fireEvent.click(screen.getByRole("button", { name: "Save" }));

		await waitFor(() => {
			expect(client.api.agents.update).toHaveBeenCalledWith({
				params: { agentId: linear.id },
				payload: { prompt: "Be terse." },
			});
		});
		expect((screen.getByRole("button", { name: "Save" }) as HTMLButtonElement).disabled).toBe(true);
	});

	it("keeps a rejected prompt open with its draft", async () => {
		client.api.agents.update.mockReturnValue(
			Effect.fail(new InternalServerError({ message: "Unavailable" })),
		);
		mount(page);
		await showTab("Prompt");

		fireEvent.change(await screen.findByLabelText("System prompt"), {
			target: { value: "Keep this." },
		});
		fireEvent.click(screen.getByRole("button", { name: "Save" }));

		expect(await screen.findByRole("alert")).toBeDefined();
		expect((screen.getByLabelText("System prompt") as HTMLTextAreaElement).value).toBe(
			"Keep this.",
		);
	});

	it("clears a crew agent's model too, which stops it until one is chosen again", async () => {
		client.api.agents.update.mockReturnValue(Effect.succeed({ ...linear, model: null }));
		mount(page);

		fireEvent.click(await screen.findByRole("button", { name: "Clear the model" }));

		await waitFor(() =>
			expect(client.api.agents.update).toHaveBeenCalledWith({
				params: { agentId: linear.id },
				payload: { model: null },
			}),
		);
	});

	it("keeps a rejected model selected for another save attempt", async () => {
		client.api.agents.update.mockReturnValue(
			Effect.fail(new InternalServerError({ message: "Unavailable" })),
		);
		mount(page);
		fireEvent.click(await screen.findByRole("button", { name: "Choose a model" }));

		(await screen.findByRole("option", { name: MODELS[1] })).click();

		await waitFor(() => expect(client.api.agents.update).toHaveBeenCalled());
		expect(await screen.findByRole("alert")).toBeDefined();
		expect((screen.getByRole("combobox", { name: "Model" }) as HTMLInputElement).value).toBe(
			MODELS[1],
		);
	});

	it("switches a built-in tool off for the agent, and back on", async () => {
		mount(page);
		await showTab("Tools");

		expect(await screen.findByText("2 of 2 on")).toBeDefined();
		const search = screen.getByRole("switch", { name: "Turn off Search the web" });
		expect(search.getAttribute("aria-checked")).toBe("true");
		rosterAnswers({ disabledTools: ["web_search"] });
		fireEvent.click(search);

		await waitFor(() => {
			expect(client.api.agents.update).toHaveBeenCalledWith({
				params: { agentId: linear.id },
				payload: { disabledTools: ["web_search"] },
			});
		});
		const off = await screen.findByRole("switch", { name: "Turn on Search the web" });
		expect(off.getAttribute("aria-checked")).toBe("false");
		expect(screen.getByText("1 of 2 on")).toBeDefined();

		rosterAnswers({ disabledTools: [] });
		fireEvent.click(off);
		await waitFor(() => {
			expect(client.api.agents.update).toHaveBeenLastCalledWith({
				params: { agentId: linear.id },
				payload: { disabledTools: [] },
			});
		});
	});

	it("shows its owning pod without placement controls", async () => {
		mount(page);

		await screen.findByRole("navigation", { name: `${suga.name} agents` });
		expect(screen.queryByRole("button", { name: "Choose a pod" })).toBeNull();
		expect(screen.queryByRole("button", { name: /^Remove from / })).toBeNull();
	});

	it("deletes the agent after asking, and returns to the list", async () => {
		client.api.agents.remove.mockReturnValue(Effect.void);
		const router = mount(page);

		open(await screen.findByRole("button", { name: `${linear.name} options` }));
		fireEvent.click(await screen.findByRole("menuitem", { name: "Delete agent" }));
		expect(client.api.agents.remove).not.toHaveBeenCalled();
		fireEvent.click(await screen.findByRole("button", { name: "Yes, delete" }));

		await waitFor(() =>
			expect(client.api.agents.remove).toHaveBeenCalledWith({
				params: { agentId: linear.id },
			}),
		);
		await waitFor(() => expect(router.state.location.pathname).toBe(`/settings/pods/${suga.id}`));
	});
});

describe("a built-in agent", () => {
	const page = "/settings/built-in-agents/facilitate";

	it("has no tabs, no menu, and nothing to edit but the model", async () => {
		mount(page);

		await screen.findByText(facilitator.description as string);
		expect(screen.queryAllByRole("tab")).toHaveLength(0);
		expect(screen.queryByRole("button", { name: `${facilitator.name} options` })).toBeNull();
		expect(screen.queryByLabelText("Description")).toBeNull();
	});

	it("says what is not happening while no model has been chosen, and offers one", async () => {
		client.api.systemAgents.list.mockReturnValue(
			Effect.succeed(builtInAgents.map((one) => ({ ...one, model: null }))),
		);
		mount(page);

		expect(await screen.findByText(/no pod can hand it the floor/)).toBeDefined();
		// Nothing to try a model check against until one is chosen.
		expect(screen.queryByRole("button", { name: "Run the check" })).toBeNull();
	});

	it("saves the model an administrator chooses for the whole workspace", async () => {
		client.api.systemAgents.update.mockReturnValue(
			Effect.succeed({ ...facilitator, model: MODELS[1] }),
		);
		mount(page);

		fireEvent.click(await screen.findByRole("button", { name: "Choose a model" }));
		(await screen.findByRole("option", { name: MODELS[1] })).click();

		await waitFor(() =>
			expect(client.api.systemAgents.update).toHaveBeenCalledWith({
				params: { workspace: workspace.id, key: "facilitate" },
				payload: { model: MODELS[1] },
			}),
		);
	});

	it("clears the model in use, which is how it is switched off", async () => {
		client.api.systemAgents.update.mockReturnValue(Effect.succeed({ ...facilitator, model: null }));
		mount(page);

		fireEvent.click(await screen.findByRole("button", { name: "Clear the model" }));

		await waitFor(() =>
			expect(client.api.systemAgents.update).toHaveBeenCalledWith({
				params: { workspace: workspace.id, key: "facilitate" },
				payload: { model: null },
			}),
		);
	});

	it("offers nothing to clear while no model has been chosen", async () => {
		client.api.systemAgents.list.mockReturnValue(
			Effect.succeed(builtInAgents.map((one) => ({ ...one, model: null }))),
		);
		mount(page);

		await screen.findByText(/no pod can hand it the floor/);
		expect(screen.queryByRole("button", { name: "Clear the model" })).toBeNull();
	});

	it("checks the chosen model on the job the built-in agent does, and says how it went", async () => {
		client.api.modelTrials.run.mockReturnValue(
			Effect.succeed({
				systemAgentKey: "facilitate",
				model: facilitator.model,
				rating: "poor",
				accuracy: { passed: 12, attempts: 18, share: 0.67, needed: 0.9, rating: "poor" },
				speed: { typicalMs: 800, slowestMs: 1_400, budgetMs: 2_000, rating: "excellent" },
				verdict: [
					"Too often wrong: right 67% of the time, where a system agent needs at least 90%.",
				],
				cases: [
					{
						name: "Stays quiet when the last message is aimed at a person",
						passed: 1,
						attempts: 3,
					},
				],
			}),
		);
		mount(page);

		fireEvent.click(await screen.findByRole("button", { name: "Run the check" }));

		expect(await screen.findByText("poor")).toBeDefined();
		expect(screen.getByText(/Too often wrong/)).toBeDefined();
		expect(screen.getByText("1/3")).toBeDefined();
		expect(client.api.modelTrials.run).toHaveBeenCalledWith({
			params: { workspace: workspace.id },
			payload: { systemAgentKey: "facilitate", model: facilitator.model },
		});
	});
});
