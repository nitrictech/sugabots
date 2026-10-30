import type { Routine } from "@sugabots/contracts";
import { Conflict, InternalServerError } from "@sugabots/contracts/http";
import { routineTriggers, type TestConnection } from "@sugabots/contracts/testing";
import { userText } from "@sugabots/errors";
import { cleanup, fireEvent, screen, waitFor, within } from "@testing-library/react";
import { Effect } from "effect";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
	agents,
	apiAnswers,
	linear,
	MODELS,
	mount,
	pendingAnswer,
	pods,
	serveConnections,
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
	triggers: routineTriggers("0199a3a0-0000-7000-8000-0000000000a1", {
		kind: "webhook",
		auth: { kind: "bearer" },
	}),
	state: "enabled",
	results: "keep_in_run",
	chatId: null,
	createdById: null,
	createdByAgentId: null,
	createdAt: "2026-09-18T00:00:00.000Z",
	updatedAt: "2026-09-18T00:00:00.000Z",
} satisfies Routine;
const scheduledRoutine = {
	...webhookRoutine,
	name: "Morning brief",
	triggers: routineTriggers("0199a3a0-0000-7000-8000-0000000000a1", {
		kind: "cron",
		schedule: { repeat: "cron", expression: "0 9 * * 1-5" },
		timezone: "America/Los_Angeles",
		nextScheduledAt: "2026-09-21T09:00:00.000Z",
	}),
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

function linearConnection(over: Partial<TestConnection> = {}): TestConnection {
	return {
		id: "0199a3a0-0000-7000-8000-0000000000f1",
		workspaceId: linear.workspaceId,
		podId: linear.podId,
		name: "Linear",
		handle: "linear",
		url: "https://mcp.linear.app/mcp",
		kind: "mcp",
		auth: "oauth",
		signedIn: true,
		secretHeader: null,
		hasSecret: false,
		appSettingsUrl: null,
		status: "connected",
		tools: [
			{
				name: "list_issues",
				description: "List issues",
				readOnly: true,
				destructive: false,
				access: "allow",
			},
		],
		lastTestedAt: "2026-09-19T00:00:00.000Z",
		lastTestError: null,
		connectedBy: null,
		createdAt: "2026-09-19T00:00:00.000Z",
		...over,
	};
}

/** Opens the bot's look by clicking its face, as a person would. */
async function openLook() {
	fireEvent.click(await screen.findByRole("button", { name: "Change look" }));
	return screen.findByRole("dialog", { name: `${linear.name}'s look` });
}

describe("what everybody sees", () => {
	it("shows the bot as a contact card: its face, name and pod first", async () => {
		mount(page);

		expect(await screen.findByRole("heading", { name: linear.name })).toBeDefined();
		expect(screen.getByRole("button", { name: "Change look" })).toBeDefined();
		expect(screen.queryByRole("tab")).toBeNull();
	});

	it("says who added it", async () => {
		mount(page);

		const profile = await screen.findByRole("region", { name: "Profile" });
		await waitFor(() => expect(within(profile).getByText("Sam")).toBeDefined());
		expect(within(profile).getByText("Added by")).toBeDefined();
	});

	it("says a bot nobody added was made with the workspace", async () => {
		rosterAnswers({ createdById: null });
		mount(page);

		const profile = await screen.findByRole("region", { name: "Profile" });
		expect(await within(profile).findByText("With the workspace")).toBeDefined();
	});

	it("lists its own tools, each a switch", async () => {
		mount(page);

		const tools = await screen.findByRole("region", { name: "Built-in tools" });
		expect(within(tools).getByText("Computer")).toBeDefined();
		expect(within(tools).getByRole("switch", { name: "Turn off Web search" })).toBeDefined();
	});

	it("shows the tools it inherits from its pod, to be changed only on the pod", async () => {
		serveConnections(
			linearConnection(),
			linearConnection({ id: "0199a3a0-0000-7000-8000-0000000000f9", name: "Wiki", tools: [] }),
		);
		mount(page);

		const inherited = await screen.findByRole("region", { name: `Inherited from ${suga.name}` });
		expect(await within(inherited).findByText("Linear")).toBeDefined();
		expect(within(inherited).getByText("Inherited")).toBeDefined();
		// A connection that gives the bot no tools gives it nothing to list.
		expect(within(inherited).queryByText("Wiki")).toBeNull();
		expect(within(inherited).queryByRole("switch")).toBeNull();
		const edit = within(inherited).getByRole("link", { name: `Edit in ${suga.name}` });
		expect(edit.getAttribute("href")).toBe(`/suga/settings/pods/${suga.slug}/connections`);
	});
});

describe("a member", () => {
	beforeEach(() => {
		apiAnswers({ role: "member" });
	});

	it("says web search is off while the workspace has none", async () => {
		client.api.searchProviders.webAccess.mockReturnValue(Effect.succeed({ enabled: false }));
		mount(page);

		expect(await screen.findByText(/^Web search is off for /)).toBeTruthy();
		const tools = screen.getByRole("region", { name: "Built-in tools" });
		expect(within(tools).queryByRole("link", { name: /^Web search/ })).toBeNull();
	});

	it("edits the model and the instructions, which a member of the pod may do", async () => {
		mount(page);

		await openSlide("Model");
		expect(await screen.findByRole("button", { name: MODELS[1] })).toBeDefined();
		fireEvent.click(within(screen.getByRole("main")).getByRole("button", { name: linear.name }));
		await openSlide("Instructions");
		expect((await screen.findByLabelText("Instructions")).hasAttribute("readonly")).toBe(false);
	});

	it("may edit it but not delete it", async () => {
		mount(page);

		expect(await screen.findByRole("textbox", { name: "Name" })).toBeDefined();
		expect(screen.getByRole("button", { name: "Change look" })).toBeDefined();
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
		expect(screen.queryByRole("button", { name: "Change look" })).toBeNull();
		expect(screen.queryByRole("textbox", { name: "Name" })).toBeNull();
		expect(screen.queryByRole("button", { name: "Delete bot" })).toBeNull();
	});
});

describe("an admin", () => {
	it("leads to its Routines page to set them up, saying how many it has", async () => {
		client.api.routines.list.mockReturnValue(Effect.succeed([scheduledRoutine, webhookRoutine]));
		mount(page);

		const row = await screen.findByRole("link", { name: /^Routines/ });
		await waitFor(() => expect(within(row).getByText("2")).toBeDefined());
		expect(row.getAttribute("href")).toBe(`/suga/pods/${suga.slug}/routines?bot=${linear.handle}`);
		expect(screen.queryByRole("button", { name: "New routine" })).toBeNull();
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
		answers({ name: "Linear Steward" });
		mount(page);

		const name = await screen.findByRole("textbox", { name: "Name" });
		fireEvent.change(name, { target: { value: "  Linear Steward  " } });
		fireEvent.blur(name);

		await waitFor(() =>
			expect(client.api.agents.update).toHaveBeenCalledWith({
				params: { agentId: linear.id },
				payload: { name: "Linear Steward" },
			}),
		);
	});

	it("puts the name back and says why when a rename is refused", async () => {
		client.api.agents.update.mockReturnValue(
			Effect.fail(new Conflict({ message: userText`An agent with that name already exists` })),
		);
		mount(page);

		const name = await screen.findByRole("textbox", { name: "Name" });
		fireEvent.change(name, { target: { value: triager.name } });
		fireEvent.blur(name);

		expect(await screen.findByRole("alert")).toBeDefined();
		await waitFor(() => expect((name as HTMLInputElement).value).toBe(linear.name));
	});

	it("puts a blank name back rather than saving it", async () => {
		mount(page);

		const name = await screen.findByRole("textbox", { name: "Name" });
		fireEvent.change(name, { target: { value: "   " } });
		fireEvent.blur(name);

		expect((name as HTMLInputElement).value).toBe(linear.name);
		expect(client.api.agents.update).not.toHaveBeenCalled();
	});

	it("writes the description when you leave it, once while a save is pending", async () => {
		const update = pendingAnswer();
		client.api.agents.update.mockReturnValue(update.effect);
		mount(page);

		const description = await screen.findByRole("textbox", { name: "Description" });
		fireEvent.blur(description);
		expect(client.api.agents.update).not.toHaveBeenCalled();

		fireEvent.change(description, { target: { value: "Digs through calls. " } });
		fireEvent.blur(description);
		await waitFor(() =>
			expect(client.api.agents.update).toHaveBeenCalledWith({
				params: { agentId: linear.id },
				payload: { description: "Digs through calls." },
			}),
		);
		fireEvent.change(description, { target: { value: "Something else" } });
		fireEvent.blur(description);
		expect(client.api.agents.update).toHaveBeenCalledOnce();
	});

	it("saves its colour, shape and eyes together from its face, on Save", async () => {
		answers({ color: "rose", face: "wink", shape: "star" });
		mount(page);

		const look = await openLook();
		const save = within(look).getByRole("button", { name: "Save" });
		expect(save.hasAttribute("disabled")).toBe(true);
		fireEvent.click(within(look).getByRole("radio", { name: "rose" }));
		fireEvent.click(within(look).getByRole("radio", { name: "star" }));
		fireEvent.click(within(look).getByRole("tab", { name: "Eyes" }));
		fireEvent.click(within(look).getByRole("radio", { name: "wink" }));
		expect(client.api.agents.update).not.toHaveBeenCalled();

		fireEvent.click(save);
		await waitFor(() =>
			expect(client.api.agents.update).toHaveBeenCalledWith({
				params: { agentId: linear.id },
				payload: { color: "rose", shape: "star", face: "wink" },
			}),
		);
		expect(client.api.agents.update).toHaveBeenCalledOnce();
		await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
	});

	it("drops the look's picks when it is closed without saving", async () => {
		mount(page);

		let look = await openLook();
		fireEvent.click(within(look).getByRole("radio", { name: "rose" }));
		fireEvent.click(within(look).getByRole("button", { name: "Cancel" }));
		await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());

		look = await openLook();
		const color = within(look).getByRole("radio", { name: linear.color });
		expect((color as HTMLInputElement).checked).toBe(true);
		expect(client.api.agents.update).not.toHaveBeenCalled();
	});

	it("keeps the look's picks open and says why when saving them fails", async () => {
		client.api.agents.update.mockReturnValue(
			Effect.fail(new InternalServerError({ message: userText`Unavailable` })),
		);
		mount(page);

		const look = await openLook();
		fireEvent.click(within(look).getByRole("radio", { name: "rose" }));
		fireEvent.click(within(look).getByRole("button", { name: "Save" }));

		expect(await within(look).findByRole("alert")).toBeDefined();
		expect((within(look).getByRole("radio", { name: "rose" }) as HTMLInputElement).checked).toBe(
			true,
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
			Effect.fail(new InternalServerError({ message: userText`Unavailable` })),
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
			Effect.fail(new InternalServerError({ message: userText`Unavailable` })),
		);
		mount(page);
		await openSlide("Model");

		fireEvent.click(await screen.findByRole("button", { name: MODELS[1] }));

		expect(await screen.findByRole("alert")).toBeDefined();
		// The save was undone, so the model in use is still the checked one.
		await waitFor(() => expect(screen.queryByRole("button", { name: MODELS[0] })).toBeNull());
		expect(screen.getByRole("button", { name: MODELS[1] })).toBeDefined();
	});

	it("switches web search off for the bot, reading pages with it, and back on", async () => {
		mount(page);

		const search = await screen.findByRole("switch", { name: "Turn off Web search" });
		expect(search.getAttribute("aria-checked")).toBe("true");
		rosterAnswers({ disabledTools: ["web_fetch", "web_search"] });
		fireEvent.click(search);

		await waitFor(() => {
			expect(client.api.agents.update).toHaveBeenCalledWith({
				params: { agentId: linear.id },
				payload: { disabledTools: ["web_fetch", "web_search"] },
			});
		});
		const off = await screen.findByRole("switch", { name: "Turn on Web search" });
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

	it("holds web search off while the workspace has none, leaving the other tools", async () => {
		client.api.searchProviders.webAccess.mockReturnValue(Effect.succeed({ enabled: false }));
		mount(page);

		await waitFor(() =>
			expect(screen.getByRole("switch", { name: "Turn on Web search" })).toHaveProperty(
				"disabled",
				true,
			),
		);
		expect(
			screen.getByRole("switch", { name: "Turn on Web search" }).getAttribute("aria-checked"),
		).toBe("false");
		const tools = screen.getByRole("region", { name: "Built-in tools" });
		expect(within(tools).queryByRole("link", { name: /^Web search/ })).toBeNull();
		const routines = screen.getByRole("switch", { name: "Turn off Manage its routines" });
		expect(routines.getAttribute("aria-checked")).toBe("true");
		expect(routines.hasAttribute("disabled")).toBe(false);
	});

	it("deletes the bot after asking, and returns to its pod's bots", async () => {
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
		await waitFor(() =>
			expect(router.state.location.pathname).toBe(`/suga/settings/pods/${suga.slug}/bots`),
		);
	});
});
