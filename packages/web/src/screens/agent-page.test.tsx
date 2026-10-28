import type { ConnectionAccess, Routine } from "@sugabots/contracts";
import { Conflict, InternalServerError } from "@sugabots/contracts/http";
import type { TestConnection } from "@sugabots/contracts/testing";
import { routineTriggers } from "@sugabots/contracts/testing";
import { userText } from "@sugabots/errors";
import { cleanup, fireEvent, screen, waitFor, within } from "@testing-library/react";
import { Effect } from "effect";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
	agents,
	apiAnswers,
	compaction,
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

/** A read, an additive change, and an overwriting one, as Linear describes them, each set as `access`. */
function readsAndWrites(
	access: [ConnectionAccess, ConnectionAccess, ConnectionAccess],
): TestConnection["tools"] {
	return [
		{ name: "list_issues", description: "List issues", readOnly: true, destructive: false },
		{ name: "create_issue_label", description: null, readOnly: false, destructive: false },
		{ name: "save_issue", description: null, readOnly: false, destructive: true },
	].map((tool, index) => ({ ...tool, access: access[index] as ConnectionAccess }));
}

describe("what everybody sees", () => {
	it("lists every bot beside the open one, each under its pod", async () => {
		mount(page);

		const main = await screen.findByRole("main");
		const list = await within(main).findByRole("link", { name: new RegExp(triager.name) });
		expect(list.textContent).toContain(suga.name);
		expect(
			within(main)
				.getByRole("link", { name: new RegExp(linear.name) })
				.getAttribute("aria-current"),
		).toBe("page");
		// A system bot is in no pod, so it is not on the list of bots.
		expect(within(main).queryByRole("link", { name: new RegExp(compaction.name) })).toBeNull();
	});

	it("shows the bot as a contact card: its face, name and pod first", async () => {
		mount(page);

		expect(await screen.findByRole("heading", { name: linear.name })).toBeDefined();
		expect(screen.getByRole("button", { name: "Change look" })).toBeDefined();
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

		expect(await screen.findByText(/Ask a workspace admin to turn it on/)).toBeTruthy();
	});

	it("edits the model and the instructions, which a member of the pod may do", async () => {
		mount(page);

		await openSlide("Model");
		expect(await screen.findByRole("button", { name: MODELS[1] })).toBeDefined();
		fireEvent.click(within(screen.getByRole("main")).getByRole("button", { name: linear.name }));
		await openSlide("Instructions");
		expect((await screen.findByLabelText("Instructions")).hasAttribute("readonly")).toBe(false);
	});

	it("lists the connections inherited from the pod, leaving out those turned off", async () => {
		serveConnections(
			linearConnection(),
			linearConnection({
				id: "0199a3a0-0000-7000-8000-0000000000f9",
				name: "Wiki",
				tools: readsAndWrites(["off", "off", "off"]),
			}),
		);
		mount(page);

		expect(await screen.findByRole("link", { name: /Linear.*1 tool/ })).toBeDefined();
		expect(screen.queryByRole("link", { name: /Wiki/ })).toBeNull();
	});

	it("opens a connection's own page from its row, with the way back to the bot", async () => {
		const connection = linearConnection({ tools: readsAndWrites(["allow", "ask", "off"]) });
		serveConnections(connection);
		const router = mount(page);

		fireEvent.click(await screen.findByRole("link", { name: /Linear.*2 tools/ }));

		await screen.findByRole("heading", { name: "Linear", level: 2 });
		expect(router.state.location.pathname).toBe(
			`/suga/settings/pods/${suga.slug}/connections/${connection.id}`,
		);
		const back = document.querySelector<HTMLElement>("[data-page-back] a");
		expect(back?.textContent).toBe(linear.name);
		if (back) fireEvent.click(back);
		await waitFor(() => expect(router.state.location.pathname).toBe(page));
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

	it("starts a new routine on this bot", async () => {
		const router = mount(page);

		fireEvent.click(await screen.findByRole("button", { name: "New routine" }));

		await waitFor(() => expect(router.state.location.pathname).toBe("/suga/settings/routines/new"));
		expect(router.state.location.search).toEqual({ agent: linear.id });
	});

	it("shows scheduled Routines in plain language, each opening its page", async () => {
		client.api.routines.list.mockReturnValue(Effect.succeed([scheduledRoutine]));
		mount(page);

		const row = await screen.findByRole("link", { name: /^Morning brief/ });
		expect(within(row).getByText("Weekdays at 9:00")).toBeDefined();
		expect(row.getAttribute("href")).toBe(`/suga/settings/routines/${scheduledRoutine.id}`);
		expect(screen.queryByText("0 9 * * 1-5")).toBeNull();
	});

	it("marks a paused Routine", async () => {
		client.api.routines.list.mockReturnValue(
			Effect.succeed([{ ...webhookRoutine, state: "paused" as const }]),
		);
		mount(page);

		const row = await screen.findByRole("link", { name: /^Triage intake/ });
		expect(within(row).getByText("Paused")).toBeDefined();
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
			Effect.fail(new Conflict({ message: userText`An agent with that name already exists` })),
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

		update.answer(Effect.fail(new InternalServerError({ message: userText`Unavailable` })));
		expect(await screen.findByRole("alert")).toBeDefined();
	});

	it("saves the bot's colour, shape and eyes from its face's pencil together, on Save", async () => {
		answers({ color: "rose", face: "wink", shape: "star" });
		mount(page);

		expect(screen.queryByRole("radio", { name: "rose" })).toBeNull();
		fireEvent.click(await screen.findByRole("button", { name: "Change look" }));
		const save = await screen.findByRole("button", { name: "Save" });
		expect(save.hasAttribute("disabled")).toBe(true);
		fireEvent.click(screen.getByRole("radio", { name: "rose" }));
		fireEvent.click(screen.getByRole("radio", { name: "wink" }));
		fireEvent.click(screen.getByRole("radio", { name: "star" }));
		expect(client.api.agents.update).not.toHaveBeenCalled();

		fireEvent.click(save);
		await waitFor(() =>
			expect(client.api.agents.update).toHaveBeenCalledWith({
				params: { agentId: linear.id },
				payload: { color: "rose", face: "wink", shape: "star" },
			}),
		);
		expect(client.api.agents.update).toHaveBeenCalledOnce();
		await waitFor(() => expect(screen.queryByRole("dialog", { name: "Look" })).toBeNull());
	});

	it("drops the look's picks when it is closed without saving", async () => {
		mount(page);

		fireEvent.click(await screen.findByRole("button", { name: "Change look" }));
		fireEvent.click(await screen.findByRole("radio", { name: "rose" }));
		fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
		await waitFor(() => expect(screen.queryByRole("dialog", { name: "Look" })).toBeNull());

		fireEvent.click(screen.getByRole("button", { name: "Change look" }));
		const color = await screen.findByRole("radio", { name: linear.color });
		expect((color as HTMLInputElement).checked).toBe(true);
		expect(client.api.agents.update).not.toHaveBeenCalled();
	});

	it("keeps the look's picks open and says why when saving them fails", async () => {
		client.api.agents.update.mockReturnValue(
			Effect.fail(new InternalServerError({ message: userText`Unavailable` })),
		);
		mount(page);

		fireEvent.click(await screen.findByRole("button", { name: "Change look" }));
		fireEvent.click(await screen.findByRole("radio", { name: "rose" }));
		fireEvent.click(screen.getByRole("button", { name: "Save" }));

		const dialog = await screen.findByRole("dialog", { name: "Look" });
		expect(await within(dialog).findByRole("alert")).toBeDefined();
		expect((within(dialog).getByRole("radio", { name: "rose" }) as HTMLInputElement).checked).toBe(
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

	it("shows the web tools off, and holds them off, while the workspace has no web access", async () => {
		client.api.searchProviders.webAccess.mockReturnValue(Effect.succeed({ enabled: false }));
		mount(page);

		for (const name of ["Search the web", "Read web pages"]) {
			const tool = await screen.findByRole("switch", { name: `Turn on ${name}` });
			expect(tool.getAttribute("aria-checked")).toBe("false");
			expect(tool.hasAttribute("disabled")).toBe(true);
		}
		const routines = screen.getByRole("switch", { name: "Turn off Manage its routines" });
		expect(routines.getAttribute("aria-checked")).toBe("true");
		expect(routines.hasAttribute("disabled")).toBe(false);
		expect(
			screen.getByRole("link", { name: "Turn it on in Web search" }).getAttribute("href"),
		).toMatch(/\/settings\/search$/);
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
