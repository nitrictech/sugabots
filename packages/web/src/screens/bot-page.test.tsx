import type { Automation } from "@sugabots/contracts";
import { Conflict, InternalServerError } from "@sugabots/contracts/http";
import { automationTriggers, type TestConnection } from "@sugabots/contracts/testing";
import { userText } from "@sugabots/errors";
import { cleanup, fireEvent, screen, waitFor, within } from "@testing-library/react";
import { Effect } from "effect";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
	apiAnswers,
	bots,
	linear,
	MODELS,
	mount,
	onWideScreen,
	open,
	pendingAnswer,
	personalAssistant,
	serveConnections,
	triager,
} from "@/test-api.tsx";
import { client } from "@/test-client.ts";

vi.mock("@/api.ts", () => import("@/test-client.ts"));

const page = `/suga/settings/bots/${linear.handle}`;
const webhookAutomation = {
	id: "0199a3a0-0000-7000-8000-0000000000a1",
	workspaceId: linear.workspaceId,
	projectId: linear.defaultProjectId,
	name: "Triage intake",
	instructions: "Triage the request.",
	triggers: automationTriggers("0199a3a0-0000-7000-8000-0000000000a1", {
		kind: "webhook",
		auth: { kind: "bearer" },
	}),
	state: "enabled",
	createdById: null,
	createdByBotId: null,
	createdAt: "2026-09-18T00:00:00.000Z",
	updatedAt: "2026-09-18T00:00:00.000Z",
} satisfies Automation;
const scheduledAutomation = {
	...webhookAutomation,
	name: "Morning brief",
	triggers: automationTriggers("0199a3a0-0000-7000-8000-0000000000a1", {
		kind: "routine",
		schedule: { repeat: "cron", expression: "0 9 * * 1-5" },
		timezone: "America/Los_Angeles",
		nextScheduledAt: "2026-09-21T09:00:00.000Z",
	}),
} satisfies Automation;

beforeEach(apiAnswers);

afterEach(() => {
	cleanup();
	vi.clearAllMocks();
});

function answers(change: Partial<typeof linear>): void {
	client.api.bots.update.mockReturnValue(Effect.succeed({ ...linear, ...change }));
}

function rosterAnswers(change: Partial<typeof linear>): void {
	answers(change);
	client.api.bots.list.mockReturnValue(
		Effect.succeed(bots.map((one) => (one.id === linear.id ? { ...one, ...change } : one))),
	);
}

/** Opens the menu of models the bot can be moved to, from its Model row. */
async function openModels() {
	open(await screen.findByRole("button", { name: /^Model: / }));
	return screen.findByRole("menu");
}

function linearConnection(over: Partial<TestConnection> = {}): TestConnection {
	return {
		id: "0199a3a0-0000-7000-8000-0000000000f1",
		workspaceId: linear.workspaceId,
		projectId: "0199a3a0-0000-7000-8000-00000000b071",
		name: "Linear",
		handle: "linear",
		url: "https://mcp.linear.app/mcp",
		kind: "mcp",
		auth: "oauth",
		signedIn: true,
		signInExpired: false,
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
	it("shows the bot as a contact card: its name first, and a way to change its look", async () => {
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

	it("shows the bot's connections, to be changed on its Connections page", async () => {
		serveConnections(
			linearConnection(),
			linearConnection({ id: "0199a3a0-0000-7000-8000-0000000000f9", name: "Wiki", tools: [] }),
		);
		mount(page);

		const connections = await screen.findByRole("region", { name: "Connections" });
		expect(await within(connections).findByText("Linear")).toBeDefined();
		// A connection that gives the bot no tools gives it nothing to list.
		expect(within(connections).queryByText("Wiki")).toBeNull();
		expect(within(connections).queryByRole("switch")).toBeNull();
		const manage = within(connections).getByRole("link", { name: "Manage" });
		expect(manage.getAttribute("href")).toBe(`${page}/connections`);
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

	it("may not change a bot somebody else made", async () => {
		mount(page);

		await screen.findByRole("heading", { name: linear.name });
		expect(screen.queryByRole("textbox", { name: "Name" })).toBeNull();
		expect(screen.queryByRole("button", { name: "Change look" })).toBeNull();
		expect(screen.queryByRole("button", { name: "Delete bot" })).toBeNull();
	});
});

describe("your Personal Assistant", () => {
	it("offers only its look and its connections to change", async () => {
		mount(`/suga/settings/bots/${personalAssistant.handle}`);

		expect(await screen.findByRole("textbox", { name: "Name" })).toBeDefined();
		expect(screen.getByRole("button", { name: "Change look" })).toBeDefined();
		expect(screen.getByRole("region", { name: "Connections" })).toBeDefined();
		expect(screen.queryByRole("button", { name: /^Model/ })).toBeNull();
		expect(screen.queryByRole("textbox", { name: "Instructions" })).toBeNull();
		expect(screen.queryByRole("region", { name: "Built-in tools" })).toBeNull();
		expect(screen.queryByRole("link", { name: /^Automations/ })).toBeNull();
		expect(screen.queryByRole("button", { name: "Delete bot" })).toBeNull();
	});

	it("keeps its computer to us", async () => {
		const router = mount(`/suga/settings/bots/${personalAssistant.handle}/computer`);

		await waitFor(() =>
			expect(router.state.location.pathname).toBe(
				`/suga/settings/bots/${personalAssistant.handle}`,
			),
		);
	});
});

describe("a viewer", () => {
	beforeEach(() => {
		apiAnswers({ role: "viewer" });
	});

	it("reads the model and the instructions rather than editing them", async () => {
		mount(page);

		expect(await screen.findByText(MODELS[0] as string)).toBeDefined();
		expect(screen.getByRole("button", { name: /^Model: / })).toHaveProperty("disabled", true);
		const instructions = await screen.findByRole("textbox", { name: "Instructions" });
		expect(instructions.hasAttribute("readonly")).toBe(true);
		expect((instructions as HTMLTextAreaElement).value).toBe("Be brief.");
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
	it("leads to its Automations page to set them up, saying how many it has", async () => {
		onWideScreen();
		client.api.automations.list.mockReturnValue(
			Effect.succeed([scheduledAutomation, webhookAutomation]),
		);
		mount(page);

		const row = await screen.findByRole("link", { name: /^Automations/ });
		await waitFor(() => expect(within(row).getByText("2")).toBeDefined());
		expect(row.getAttribute("href")).toBe(`/suga/bots/${linear.handle}/automations`);
		expect(screen.queryByRole("button", { name: "New automation" })).toBeNull();
	});

	it("discards the previous bot's draft instructions when another bot is opened", async () => {
		const router = mount(page);
		fireEvent.change(await screen.findByRole("textbox", { name: "Instructions" }), {
			target: { value: "Private draft" },
		});

		await router.navigate({
			to: "/$workspace/settings/bots/$bot",
			params: { workspace: "suga", bot: triager.handle },
		});

		await waitFor(() => expect(screen.queryByDisplayValue("Private draft")).toBeNull());
		expect(client.api.bots.update).not.toHaveBeenCalled();
	});

	it("renames the bot when you leave its name", async () => {
		answers({ name: "Linear Steward" });
		mount(page);

		const name = await screen.findByRole("textbox", { name: "Name" });
		fireEvent.change(name, { target: { value: "  Linear Steward  " } });
		fireEvent.blur(name);

		await waitFor(() =>
			expect(client.api.bots.update).toHaveBeenCalledWith({
				params: { botId: linear.id },
				payload: { name: "Linear Steward" },
			}),
		);
	});

	it("puts the name back and says why when a rename is refused", async () => {
		client.api.bots.update.mockReturnValue(
			Effect.fail(new Conflict({ message: userText`A bot with that name already exists` })),
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
		expect(client.api.bots.update).not.toHaveBeenCalled();
	});

	it("writes the description when you leave it, once while a save is pending", async () => {
		const update = pendingAnswer();
		client.api.bots.update.mockReturnValue(update.effect);
		mount(page);

		const description = await screen.findByRole("textbox", { name: "Description" });
		fireEvent.blur(description);
		expect(client.api.bots.update).not.toHaveBeenCalled();

		fireEvent.change(description, { target: { value: "Digs through calls. " } });
		fireEvent.blur(description);
		await waitFor(() =>
			expect(client.api.bots.update).toHaveBeenCalledWith({
				params: { botId: linear.id },
				payload: { description: "Digs through calls." },
			}),
		);
		fireEvent.change(description, { target: { value: "Something else" } });
		fireEvent.blur(description);
		expect(client.api.bots.update).toHaveBeenCalledOnce();
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
		expect(client.api.bots.update).not.toHaveBeenCalled();

		fireEvent.click(save);
		await waitFor(() =>
			expect(client.api.bots.update).toHaveBeenCalledWith({
				params: { botId: linear.id },
				payload: { color: "rose", shape: "star", face: "wink" },
			}),
		);
		expect(client.api.bots.update).toHaveBeenCalledOnce();
		await waitFor(() =>
			expect(screen.queryByRole("dialog", { name: `${linear.name}'s look` })).toBeNull(),
		);
	});

	it("drops the look's picks when it is closed without saving", async () => {
		mount(page);

		let look = await openLook();
		fireEvent.click(within(look).getByRole("radio", { name: "rose" }));
		fireEvent.click(within(look).getByRole("button", { name: "Cancel" }));
		await waitFor(() =>
			expect(screen.queryByRole("dialog", { name: `${linear.name}'s look` })).toBeNull(),
		);

		look = await openLook();
		const color = within(look).getByRole("radio", { name: linear.color });
		expect((color as HTMLInputElement).checked).toBe(true);
		expect(client.api.bots.update).not.toHaveBeenCalled();
	});

	it("keeps the look's picks open and says why when saving them fails", async () => {
		client.api.bots.update.mockReturnValue(
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

	it("leaves instructions that have not changed unsaved", async () => {
		mount(page);

		fireEvent.blur(await screen.findByRole("textbox", { name: "Instructions" }));

		expect(client.api.bots.update).not.toHaveBeenCalled();
	});

	it("counts the instructions against their limit", async () => {
		mount(page);

		expect(await screen.findByText(/9 of 20,000 characters/)).toBeDefined();
	});

	it("saves the instructions once the box is left", async () => {
		mount(page);

		const instructions = await screen.findByRole("textbox", { name: "Instructions" });
		fireEvent.change(instructions, { target: { value: "Be terse." } });
		rosterAnswers({ prompt: "Be terse." });
		expect(client.api.bots.update).not.toHaveBeenCalled();
		fireEvent.blur(instructions);

		await waitFor(() => {
			expect(client.api.bots.update).toHaveBeenCalledWith({
				params: { botId: linear.id },
				payload: { prompt: "Be terse." },
			});
		});
	});

	it("puts rejected instructions back and says why", async () => {
		client.api.bots.update.mockReturnValue(
			Effect.fail(new InternalServerError({ message: userText`Unavailable` })),
		);
		mount(page);

		const instructions = await screen.findByRole("textbox", { name: "Instructions" });
		fireEvent.change(instructions, { target: { value: "Keep this." } });
		fireEvent.blur(instructions);

		expect(await screen.findByRole("alert")).toBeDefined();
		await waitFor(() =>
			expect(
				(screen.getByRole("textbox", { name: "Instructions" }) as HTMLTextAreaElement).value,
			).toBe("Be brief."),
		);
	});

	it("chooses a model from those switched on, each with its provider", async () => {
		client.api.bots.update.mockReturnValue(Effect.succeed({ ...linear, model: MODELS[1] }));
		mount(page);
		const models = await openModels();

		// The one in use is checked.
		expect(
			within(models).getByRole("menuitemradio", { name: new RegExp(`^${MODELS[0]}`) }),
		).toHaveProperty("ariaChecked", "true");
		fireEvent.click(
			within(models).getByRole("menuitemradio", { name: new RegExp(`^${MODELS[1]}`) }),
		);

		await waitFor(() =>
			expect(client.api.bots.update).toHaveBeenCalledWith({
				params: { botId: linear.id },
				payload: { model: MODELS[1] },
			}),
		);
	});

	it("says when a model could not be chosen, and keeps the one in use", async () => {
		client.api.bots.update.mockReturnValue(
			Effect.fail(new InternalServerError({ message: userText`Unavailable` })),
		);
		mount(page);
		const models = await openModels();

		fireEvent.click(
			within(models).getByRole("menuitemradio", { name: new RegExp(`^${MODELS[1]}`) }),
		);

		expect(await screen.findByRole("alert")).toBeDefined();
		expect(screen.getByRole("button", { name: `Model: ${MODELS[0]}` })).toBeDefined();
	});

	it("switches web search off for the bot, reading pages with it, and back on", async () => {
		mount(page);

		const search = await screen.findByRole("switch", { name: "Turn off Web search" });
		expect(search.getAttribute("aria-checked")).toBe("true");
		rosterAnswers({ disabledTools: ["web_fetch", "web_search"] });
		fireEvent.click(search);

		await waitFor(() => {
			expect(client.api.bots.update).toHaveBeenCalledWith({
				params: { botId: linear.id },
				payload: { disabledTools: ["web_fetch", "web_search"] },
			});
		});
		const off = await screen.findByRole("switch", { name: "Turn on Web search" });
		expect(off.getAttribute("aria-checked")).toBe("false");

		rosterAnswers({ disabledTools: [] });
		fireEvent.click(off);
		await waitFor(() => {
			expect(client.api.bots.update).toHaveBeenLastCalledWith({
				params: { botId: linear.id },
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
		const automations = screen.getByRole("switch", { name: "Turn off Manage its automations" });
		expect(automations.getAttribute("aria-checked")).toBe("true");
		expect(automations.hasAttribute("disabled")).toBe(false);
	});

	it("deletes the bot after asking, and returns to the workspace's bots", async () => {
		client.api.bots.remove.mockReturnValue(Effect.void);
		const router = mount(page);

		fireEvent.click(await screen.findByRole("button", { name: "Delete bot" }));
		expect(client.api.bots.remove).not.toHaveBeenCalled();
		fireEvent.click(await screen.findByRole("button", { name: "Delete" }));

		await waitFor(() =>
			expect(client.api.bots.remove).toHaveBeenCalledWith({
				params: { botId: linear.id },
			}),
		);
		await waitFor(() => expect(router.state.location.pathname).toBe("/suga/settings/bots"));
	});

	it("goes back to the bots it was opened from when deleted, rather than opening them again", async () => {
		client.api.bots.remove.mockReturnValue(Effect.void);
		const bots = "/suga/settings/bots";
		const router = mount(bots);
		await screen.findAllByRole("heading", { name: "Bots" });
		await router.navigate({ href: page });

		fireEvent.click(await screen.findByRole("button", { name: "Delete bot" }));
		fireEvent.click(await screen.findByRole("button", { name: "Delete" }));

		await waitFor(() => expect(router.state.location.pathname).toBe(bots));
		// Where Bots was, not a step after the deleted bot, so Back from Bots doesn't stay on Bots.
		expect(router.history.canGoBack()).toBe(false);
	});
});
