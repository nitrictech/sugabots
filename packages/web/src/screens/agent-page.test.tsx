import type { Connection, Routine } from "@sugabots/contracts";
import { Conflict, InternalServerError } from "@sugabots/contracts/http";
import { cleanup, fireEvent, screen, waitFor, within } from "@testing-library/react";
import { Effect } from "effect";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
	agents,
	apiAnswers,
	facilitator,
	linear,
	MODELS,
	mount,
	pendingAnswer,
	pods,
	triager,
} from "@/test-api.tsx";
import { client } from "@/test-client.ts";

vi.mock("@/api.ts", () => import("@/test-client.ts"));

const page = `/suga/settings/pods/suga-team/agents/${linear.handle}`;
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

async function openSlide(name: "Model" | "Instructions") {
	fireEvent.click(await screen.findByRole("button", { name: new RegExp(`^${name}`) }));
}

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
		access: "allow",
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

describe("what everybody sees", () => {
	it("lists every bot beside the open one, each under its pod", async () => {
		mount(page);

		const list = await screen.findByRole("link", { name: new RegExp(triager.name) });
		expect(list.textContent).toContain(suga.name);
		expect(
			screen.getByRole("link", { name: new RegExp(linear.name) }).getAttribute("aria-current"),
		).toBe("page");
		// A system bot is in no pod, so it is not on the list of bots.
		expect(screen.queryByRole("link", { name: new RegExp(facilitator.name) })).toBeNull();
	});

	it("shows the bot as a contact card: its face, name and pod first", async () => {
		mount(page);

		expect(await screen.findByRole("heading", { name: linear.name })).toBeDefined();
		expect(screen.getByRole("group", { name: "Colour" })).toBeDefined();
		expect(screen.getByRole("group", { name: "Eyes" })).toBeDefined();
		expect(screen.queryByRole("tab")).toBeNull();
	});

	it("offers the tools it shares with its pod, and the pod's own settings for them", async () => {
		mount(page);

		const shared = await screen.findByRole("link", { name: new RegExp(`Tools from ${suga.name}`) });
		expect(shared.getAttribute("href")).toBe(`/suga/settings/pods/${suga.slug}`);
		expect(screen.getByText("Read web pages")).toBeDefined();
		expect(screen.getByText("Search the web")).toBeDefined();
	});
});

describe("a member", () => {
	beforeEach(() => {
		apiAnswers({ role: "member" });
	});

	it("says to ask an admin while the workspace has no web access", async () => {
		client.api.searchProviders.webAccess.mockReturnValue(Effect.succeed({ enabled: false }));
		mount(page);

		expect(
			await screen.findAllByText("Off for the workspace. Ask an admin to turn on web search."),
		).toHaveLength(2);
	});

	it("edits the model and the instructions, which a member of the pod may do", async () => {
		mount(page);

		await openSlide("Model");
		expect(await screen.findByRole("button", { name: MODELS[1] })).toBeDefined();
		fireEvent.click(screen.getByRole("button", { name: linear.name }));
		await openSlide("Instructions");
		expect((await screen.findByLabelText("Instructions")).hasAttribute("readonly")).toBe(false);
	});

	it("lists the connections inherited from the pod, leaving out those turned off", async () => {
		client.api.connections.list.mockReturnValue(
			Effect.succeed([
				linearConnection(),
				linearConnection({
					id: "0199a3a0-0000-7000-8000-0000000000f9",
					name: "Wiki",
					access: "off",
				}),
			]),
		);
		mount(page);

		expect(await screen.findByRole("button", { name: /Linear.*1 tool/ })).toBeDefined();
		expect(screen.queryByRole("button", { name: /Wiki/ })).toBeNull();
	});

	it("says a change asks first, and a read runs freely", async () => {
		client.api.connections.list.mockReturnValue(
			Effect.succeed([linearConnection({ tools: readsAndWrites })]),
		);
		mount(page);

		fireEvent.click(await screen.findByRole("button", { name: /Linear.*3 tools/ }));

		const tools = await screen.findByRole("dialog", { name: "Linear tools" });
		const free = within(tools).getByRole("region", { name: "Runs freely" });
		expect(within(free).getByText("List issues")).toBeDefined();
		const asks = within(tools).getByRole("region", { name: "Asks first" });
		expect(within(asks).getByText("Create issue label")).toBeDefined();
		expect(within(asks).getByText("Save issue")).toBeDefined();
	});

	it("asks first for every tool of a connection set to ask", async () => {
		client.api.connections.list.mockReturnValue(
			Effect.succeed([linearConnection({ tools: readsAndWrites, access: "ask" })]),
		);
		mount(page);

		fireEvent.click(await screen.findByRole("button", { name: /Linear.*3 tools/ }));

		const tools = await screen.findByRole("dialog", { name: "Linear tools" });
		expect(within(tools).queryByRole("region", { name: "Runs freely" })).toBeNull();
		const asks = within(tools).getByRole("region", { name: "Asks first" });
		expect(within(asks).getByText("List issues")).toBeDefined();
	});

	it("may rename it but not delete it", async () => {
		mount(page);

		expect(await screen.findByRole("textbox", { name: "Name" })).toBeDefined();
		expect(screen.queryByRole("button", { name: "Delete bot" })).toBeNull();
	});
});

describe("a viewer", () => {
	beforeEach(() => {
		apiAnswers({ role: "viewer" });
	});

	it("reads the model and the instructions rather than editing them", async () => {
		mount(page);

		expect(await screen.findByText(MODELS[0] as string)).toBeDefined();
		await openSlide("Instructions");
		const instructions = await screen.findByLabelText("Instructions");
		expect(instructions.hasAttribute("readonly")).toBe(true);
		expect((instructions as HTMLTextAreaElement).value).toBe("Be brief.");
		expect(screen.queryByRole("button", { name: "Save" })).toBeNull();
	});

	it("is offered no way to rename, restyle or delete the bot", async () => {
		mount(page);

		await screen.findByRole("heading", { name: linear.name });
		expect(screen.queryByRole("textbox", { name: "Name" })).toBeNull();
		expect(screen.queryByRole("group", { name: "Colour" })).toBeNull();
		expect(screen.queryByRole("button", { name: "Delete bot" })).toBeNull();
	});
});

describe("an admin", () => {
	it("opens a directly linked Routine definition with its routines", async () => {
		mount(`${page}?tab=routines`);

		expect(await screen.findByRole("button", { name: "New routine" })).toBeDefined();
	});

	it("saves a weekly schedule as cron in the detected timezone", async () => {
		const timezone = Intl.DateTimeFormat().resolvedOptions().timeZone;
		client.api.routines.create.mockReturnValue(
			Effect.succeed({ routine: scheduledRoutine, secret: null }),
		);
		mount(page);
		fireEvent.click(await screen.findByRole("button", { name: "New routine" }));
		const dialog = await screen.findByRole("dialog", { name: "New routine" });
		fireEvent.change(within(dialog).getByLabelText("Name"), {
			target: { value: "Weekly review" },
		});
		fireEvent.click(within(dialog).getByRole("button", { name: "Instructions" }));
		const slide = await screen.findByRole("dialog", { name: "Instructions" });
		fireEvent.change(within(slide).getByLabelText("Instructions"), {
			target: { value: "Review the week." },
		});
		fireEvent.click(within(slide).getByRole("button", { name: "Back" }));
		const form = await screen.findByRole("dialog", { name: "New routine" });
		fireEvent.click(within(form).getByRole("radio", { name: "Weekly" }));
		fireEvent.click(within(form).getByRole("checkbox", { name: "Thursday" }));
		fireEvent.click(within(form).getByRole("button", { name: "Later" }));
		fireEvent.click(within(form).getByRole("button", { name: "Later" }));
		expect(within(form).getByText(/Runs Mondays and Thursdays at 10:00/)).toBeDefined();
		fireEvent.click(within(form).getByRole("button", { name: "Create" }));

		await waitFor(() => {
			expect(client.api.routines.create).toHaveBeenCalledWith({
				params: { agentId: linear.id },
				payload: {
					name: "Weekly review",
					instructions: "Review the week.",
					trigger: { kind: "cron", expression: "0 10 * * 1,4", timezone },
				},
			});
		});
		await waitFor(() => expect(screen.queryByRole("dialog", { name: "New routine" })).toBeNull());
	});

	it("shows a new webhook routine's address and secret once, before closing", async () => {
		const secret = "whsec_0123456789abcdef0123456789abcdef";
		client.api.routines.create.mockReturnValue(Effect.succeed({ routine: webhookRoutine, secret }));
		mount(page);
		fireEvent.click(await screen.findByRole("button", { name: "New routine" }));
		const dialog = await screen.findByRole("dialog", { name: "New routine" });
		fireEvent.change(within(dialog).getByLabelText("Name"), {
			target: { value: webhookRoutine.name },
		});
		fireEvent.click(within(dialog).getByRole("button", { name: "Instructions" }));
		const slide = await screen.findByRole("dialog", { name: "Instructions" });
		fireEvent.change(within(slide).getByLabelText("Instructions"), {
			target: { value: webhookRoutine.instructions },
		});
		fireEvent.click(within(slide).getByRole("button", { name: "Back" }));
		const form = await screen.findByRole("dialog", { name: "New routine" });
		fireEvent.click(within(form).getByRole("radio", { name: "Webhook" }));
		fireEvent.click(within(form).getByRole("button", { name: "Create" }));

		const ready = await screen.findByRole("dialog", { name: "Webhook ready" });
		expect(
			within(ready).getByText(new RegExp(`/hooks/routines/${webhookRoutine.id}$`)),
		).toBeDefined();
		expect(within(ready).queryByText(secret)).toBeNull();
		fireEvent.click(within(ready).getByRole("button", { name: "Show" }));
		expect(within(ready).getByText(secret)).toBeDefined();
		fireEvent.click(within(ready).getByRole("button", { name: "Done" }));
		await waitFor(() => expect(screen.queryByRole("dialog", { name: "Webhook ready" })).toBeNull());
	});

	it("shows scheduled Routines in plain language", async () => {
		client.api.routines.list.mockReturnValue(Effect.succeed([scheduledRoutine]));
		mount(page);

		expect(await screen.findByText("Weekdays at 9:00")).toBeDefined();
		expect(screen.queryByText(scheduledRoutine.trigger.expression)).toBeNull();
	});

	it("says when a Routine could not be paused, or its secret reset", async () => {
		client.api.routines.list.mockReturnValue(Effect.succeed([webhookRoutine]));
		client.api.routines.update.mockReturnValue(
			Effect.fail(new InternalServerError({ message: "Update unavailable" })),
		);
		client.api.routines.rotateSecret.mockReturnValue(
			Effect.fail(new InternalServerError({ message: "Rotation unavailable" })),
		);
		mount(page);

		fireEvent.click(await screen.findByRole("switch", { name: `${webhookRoutine.name} on` }));
		expect((await screen.findByRole("alert")).textContent).toContain("Update unavailable");
		expect(client.api.routines.update).toHaveBeenCalledWith({
			params: { agentId: linear.id, routineId: webhookRoutine.id },
			payload: { state: "paused" },
		});

		fireEvent.click(screen.getByRole("button", { name: new RegExp(webhookRoutine.name) }));
		const dialog = await screen.findByRole("dialog", { name: "Edit routine" });
		fireEvent.click(within(dialog).getByRole("button", { name: "Reset" }));
		const confirm = await screen.findByRole("dialog", { name: "Reset the secret?" });
		expect(client.api.routines.rotateSecret).not.toHaveBeenCalled();
		fireEvent.click(within(confirm).getByRole("button", { name: "Reset" }));
		await waitFor(() =>
			expect(within(confirm).getByRole("alert").textContent).toContain("Rotation unavailable"),
		);
	});

	it("deletes a Routine from its dialog after asking", async () => {
		client.api.routines.list.mockReturnValue(Effect.succeed([scheduledRoutine]));
		client.api.routines.remove.mockReturnValue(Effect.void);
		mount(page);

		fireEvent.click(await screen.findByRole("button", { name: new RegExp(scheduledRoutine.name) }));
		const dialog = await screen.findByRole("dialog", { name: "Edit routine" });
		fireEvent.click(within(dialog).getByRole("button", { name: "Delete routine" }));
		const confirm = await screen.findByRole("dialog", {
			name: `Delete ${scheduledRoutine.name}?`,
		});
		expect(client.api.routines.remove).not.toHaveBeenCalled();
		fireEvent.click(within(confirm).getByRole("button", { name: "Delete" }));

		await waitFor(() =>
			expect(client.api.routines.remove).toHaveBeenCalledWith({
				params: { agentId: linear.id, routineId: scheduledRoutine.id },
			}),
		);
		await waitFor(() => expect(screen.queryByRole("dialog", { name: "Edit routine" })).toBeNull());
	});

	it("discards the previous bot's draft instructions when another bot is opened", async () => {
		const router = mount(page);
		await openSlide("Instructions");
		fireEvent.change(await screen.findByLabelText("Instructions"), {
			target: { value: "Private draft" },
		});

		await router.navigate({
			to: "/$workspace/settings/pods/$pod/agents/$agent",
			params: { workspace: "suga", pod: suga.slug, agent: triager.handle },
		});

		await waitFor(() => expect(screen.queryByLabelText("Instructions")).toBeNull());
		expect(client.api.agents.update).not.toHaveBeenCalled();
	});

	it("renames the bot when you leave its name", async () => {
		const renamed = { ...linear, name: "Linear Steward" };
		answers({ name: renamed.name });
		mount(page);

		const name = await screen.findByRole("textbox", { name: "Name" });
		fireEvent.change(name, { target: { value: `  ${renamed.name}  ` } });
		fireEvent.blur(name);

		await waitFor(() => {
			expect(client.api.agents.update).toHaveBeenCalledWith({
				params: { agentId: linear.id },
				payload: { name: renamed.name },
			});
		});
	});

	it("puts the name back and says why when a rename is refused", async () => {
		client.api.agents.update.mockReturnValue(
			Effect.fail(new Conflict({ message: "An agent with that name already exists" })),
		);
		mount(page);

		const name = await screen.findByRole("textbox", { name: "Name" });
		fireEvent.change(name, { target: { value: triager.name } });
		fireEvent.blur(name);

		expect(await screen.findByRole("alert")).toBeDefined();
		await waitFor(() => expect((name as HTMLInputElement).value).toBe(linear.name));
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
	});

	it("changes the bot's colour and eyes as soon as they are picked", async () => {
		answers({ color: "rose" });
		mount(page);

		fireEvent.click(await screen.findByRole("radio", { name: "rose" }));
		await waitFor(() =>
			expect(client.api.agents.update).toHaveBeenCalledWith({
				params: { agentId: linear.id },
				payload: { color: "rose" },
			}),
		);
		fireEvent.click(screen.getByRole("radio", { name: "wink" }));
		await waitFor(() =>
			expect(client.api.agents.update).toHaveBeenLastCalledWith({
				params: { agentId: linear.id },
				payload: { face: "wink" },
			}),
		);
	});

	it("cannot save instructions that have not changed", async () => {
		mount(page);
		await openSlide("Instructions");

		const save = await screen.findByRole("button", { name: "Save" });
		expect((save as HTMLButtonElement).disabled).toBe(true);
	});

	it("counts the instructions against their limit", async () => {
		mount(page);
		await openSlide("Instructions");

		expect(await screen.findByText(/9 of 20,000 characters/)).toBeDefined();
	});

	it("saves the instructions", async () => {
		mount(page);
		await openSlide("Instructions");

		fireEvent.change(await screen.findByLabelText("Instructions"), {
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
	});

	it("keeps rejected instructions open with their draft", async () => {
		client.api.agents.update.mockReturnValue(
			Effect.fail(new InternalServerError({ message: "Unavailable" })),
		);
		mount(page);
		await openSlide("Instructions");

		fireEvent.change(await screen.findByLabelText("Instructions"), {
			target: { value: "Keep this." },
		});
		fireEvent.click(screen.getByRole("button", { name: "Save" }));

		expect(await screen.findByRole("alert")).toBeDefined();
		expect((screen.getByLabelText("Instructions") as HTMLTextAreaElement).value).toBe("Keep this.");
	});

	it("chooses a model from those switched on, grouped by provider", async () => {
		client.api.agents.update.mockReturnValue(Effect.succeed({ ...linear, model: MODELS[1] }));
		mount(page);
		await openSlide("Model");

		expect(await screen.findByRole("heading", { name: "Anthropic" })).toBeDefined();
		// The one in use is checked, with nothing to press.
		expect(screen.queryByRole("button", { name: MODELS[0] })).toBeNull();
		fireEvent.click(await screen.findByRole("button", { name: MODELS[1] }));

		await waitFor(() =>
			expect(client.api.agents.update).toHaveBeenCalledWith({
				params: { agentId: linear.id },
				payload: { model: MODELS[1] },
			}),
		);
	});

	it("says when a model could not be chosen, and keeps the one in use", async () => {
		client.api.agents.update.mockReturnValue(
			Effect.fail(new InternalServerError({ message: "Unavailable" })),
		);
		mount(page);
		await openSlide("Model");

		fireEvent.click(await screen.findByRole("button", { name: MODELS[1] }));

		expect(await screen.findByRole("alert")).toBeDefined();
		// The save was undone, so the model in use is still the checked one.
		await waitFor(() => expect(screen.queryByRole("button", { name: MODELS[0] })).toBeNull());
		expect(screen.getByRole("button", { name: MODELS[1] })).toBeDefined();
	});

	it("switches a built-in tool off for the bot, and back on", async () => {
		mount(page);

		const search = await screen.findByRole("switch", { name: "Turn off Search the web" });
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

		rosterAnswers({ disabledTools: [] });
		fireEvent.click(off);
		await waitFor(() => {
			expect(client.api.agents.update).toHaveBeenLastCalledWith({
				params: { agentId: linear.id },
				payload: { disabledTools: [] },
			});
		});
	});

	it("shows the built-in tools off, and holds them off, while the workspace has no web access", async () => {
		client.api.searchProviders.webAccess.mockReturnValue(Effect.succeed({ enabled: false }));
		mount(page);

		for (const name of ["Search the web", "Read web pages"]) {
			const tool = await screen.findByRole("switch", { name: `Turn on ${name}` });
			expect(tool.getAttribute("aria-checked")).toBe("false");
			expect(tool.hasAttribute("disabled")).toBe(true);
		}
		expect(
			screen.getAllByText("Off for the workspace. Turn on web search in settings."),
		).toHaveLength(2);
	});

	it("deletes the bot after asking, and returns to the list", async () => {
		client.api.agents.remove.mockReturnValue(Effect.void);
		const router = mount(page);

		fireEvent.click(await screen.findByRole("button", { name: "Delete bot" }));
		expect(client.api.agents.remove).not.toHaveBeenCalled();
		fireEvent.click(await screen.findByRole("button", { name: "Delete" }));

		await waitFor(() =>
			expect(client.api.agents.remove).toHaveBeenCalledWith({
				params: { agentId: linear.id },
			}),
		);
		await waitFor(() => expect(router.state.location.pathname).toBe("/suga/settings/agents"));
	});
});
