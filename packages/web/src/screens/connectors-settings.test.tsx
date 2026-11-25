import type { ConnectorAccess } from "@sugabots/contracts";
import { BadRequest } from "@sugabots/contracts/http";
import { listedConnector, type TestConnector } from "@sugabots/contracts/testing";
import { userText } from "@sugabots/errors";
import { cleanup, fireEvent, screen, waitFor, within } from "@testing-library/react";
import { Effect } from "effect";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
	apiAnswers,
	linear,
	mount,
	projects,
	serveConnectors,
	triager,
} from "@/api.test-support.tsx";
import { client } from "@/client.test-support.ts";
import { browser } from "@/lib/connectors.ts";

vi.mock("@/api.ts", () => import("@/client.test-support.ts"));

const project = projects[0] as (typeof projects)[number];
const route = client.api.connectors;

const wiki: TestConnector = {
	id: "0199a3a0-0000-7000-8000-0000000000f1",
	workspaceId: linear.workspaceId,
	projectId: linear.defaultProjectId,
	name: "Wiki",
	handle: "wiki",
	url: "https://wiki.wikimple.com/mcp",
	kind: "mcp",
	auth: "header",
	signedIn: true,
	signInExpired: false,
	secretHeader: "authorization",
	hasSecret: false,
	appSettingsUrl: null,
	status: "connected",
	tools: [
		{
			name: "search_pages",
			description: "Search the wiki for pages.",
			readOnly: true,
			destructive: null,
			access: "off",
		},
		{
			name: "wipe",
			description: "Removes it all.",
			readOnly: false,
			destructive: true,
			access: "off",
		},
	],
	lastTestError: null,
	connectedBy: {
		id: "0199a3a0-0000-7000-8000-0000000000c1",
		name: "Sam",
		email: "sam@example.com",
		image: null,
	},
	signedInAs: null,
	createdAt: "2026-09-14T00:00:00.000Z",
};

/** The Wiki with every one of its tools set to `access`. */
const wikiAt = (access: ConnectorAccess): TestConnector => ({
	...wiki,
	tools: wiki.tools.map((tool) => ({ ...tool, access })),
});

beforeEach(() => {
	apiAnswers();
});

afterEach(cleanup);

/** The bot's Connectors, a page of its own beside its chats. */
const connectorsPage = `/suga/bots/${linear.handle}/connectors`;
const wikiPage = `${connectorsPage}/${wiki.id}`;

/** The connector's own page, once it and its tools have loaded. */
async function openedWiki() {
	await screen.findByRole("heading", { name: "Wiki", level: 1 });
	await screen.findByRole("region", { name: "Tools that read" });
	await waitFor(() => expect(screen.queryByRole("status", { name: "Loading tools" })).toBeNull());
}

/** The connector's Individual tools, opened from its page. */
async function openIndividualTools() {
	fireEvent.click(screen.getByRole("button", { name: /^Individual tools/ }));
	await screen.findByRole("heading", { name: "Individual tools", level: 2 });
}

/** The bot's Connectors page, once it has loaded. */
async function showConnectors() {
	await screen.findByRole("heading", { name: "Connectors" });
}

/** Opens Add connector, and the dialog it opens. */
async function openAdd() {
	fireEvent.click(await screen.findByRole("button", { name: "Add connector" }));
	return screen.findByRole("dialog", { name: `Add to ${linear.name}` });
}

describe("a bot's Connectors page", () => {
	it("connects a built-in connector by signing in, leaving its tools to start at their defaults", async () => {
		const go = vi.spyOn(browser, "go").mockImplementation(() => undefined);
		serveConnectors();
		route.connectBuiltIn.mockReturnValue(
			Effect.succeed({
				connectorId: "0199a3a0-0000-7000-8000-0000000000f2",
				authorizationUrl: "https://notion.example/authorize?state=s-1",
			}),
		);
		mount(connectorsPage);
		await showConnectors();

		const list = await openAdd();
		fireEvent.click(within(list).getByRole("button", { name: /^Notion/ }));
		const step = await screen.findByRole("dialog", { name: "Notion" });
		expect(within(step).queryByRole("radio")).toBeNull();
		fireEvent.click(within(step).getByRole("button", { name: /Connect Notion/ }));

		await waitFor(() =>
			expect(go).toHaveBeenCalledWith("https://notion.example/authorize?state=s-1"),
		);
		expect(route.connectBuiltIn.mock.calls[0]?.[0]).toMatchObject({
			payload: { name: "Notion", url: "https://mcp.notion.com/mcp" },
		});
		expect(route.update).not.toHaveBeenCalled();
		expect(route.create).not.toHaveBeenCalled();
	});

	it("offers to sign in a connector whose sign-in never finished", async () => {
		const go = vi.spyOn(browser, "go").mockImplementation(() => undefined);
		serveConnectors({ ...wiki, auth: "oauth", signedIn: false, secretHeader: null });
		route.startOAuth.mockReturnValue(
			Effect.succeed({ authorizationUrl: "https://wiki.example/authorize" }),
		);
		mount(connectorsPage);
		await showConnectors();

		const row = await screen.findByRole("article", { name: "Wiki" });
		within(row).getByText("Not signed in yet");
		fireEvent.click(within(row).getByRole("button", { name: "Sign in" }));

		await waitFor(() => expect(go).toHaveBeenCalledWith("https://wiki.example/authorize"));
	});

	it("says on a connector's page who it is signed in as, or offers to sign it in", async () => {
		// Kim signed in the connector Sam added.
		const kim = {
			id: "0199a3a0-0000-7000-8000-0000000000c2",
			name: "Kim",
			email: "kim@example.com",
			image: null,
		};
		serveConnectors({
			...wiki,
			auth: "oauth",
			signedIn: true,
			secretHeader: null,
			signedInAs: kim,
		});
		mount(wikiPage);

		const account = await screen.findByRole("region", { name: "Account" });
		within(account).getByText("Signed in as");
		within(account).getByText("Kim");
		cleanup();

		mount(connectorsPage);
		await showConnectors();
		const row = await screen.findByRole("article", { name: "Wiki" });
		within(row).getByText(/· Signed in as Kim$/);
		expect(within(account).queryByRole("button", { name: "Sign in" })).toBeNull();
		cleanup();

		serveConnectors({ ...wiki, auth: "oauth", signedIn: false, secretHeader: null });
		mount(wikiPage);

		const notYet = await screen.findByRole("region", { name: "Account" });
		within(notYet).getByRole("button", { name: "Sign in" });
	});

	it("adds any other server by name and address", async () => {
		serveConnectors();
		route.create.mockImplementation(() => {
			serveConnectors(wiki);
			return Effect.succeed(listedConnector(wiki));
		});
		mount(connectorsPage);
		await showConnectors();

		fireEvent.click(within(await openAdd()).getByRole("button", { name: /Connect by URL/ }));
		const step = await screen.findByRole("dialog", { name: "Connect by URL" });
		fireEvent.change(within(step).getByLabelText("Name"), { target: { value: "Wiki" } });
		fireEvent.change(within(step).getByLabelText("Server URL"), {
			target: { value: "https://wiki.example.com/mcp" },
		});
		fireEvent.change(within(step).getByLabelText("Access token"), {
			target: { value: " Bearer abc123 " },
		});
		fireEvent.click(within(step).getByRole("button", { name: "Add" }));

		await waitFor(() => expect(route.create).toHaveBeenCalledOnce());
		expect(route.create.mock.calls[0]?.[0]).toMatchObject({
			payload: {
				name: "Wiki",
				url: "https://wiki.example.com/mcp",
				secretHeader: "Authorization",
				secret: "Bearer abc123",
			},
		});
		await screen.findByRole("article", { name: "Wiki" });
		expect(route.update).not.toHaveBeenCalled();
	});

	it("adds an HTTP endpoint with no secret", async () => {
		serveConnectors();
		route.create.mockImplementation(() =>
			Effect.succeed(listedConnector({ ...wiki, kind: "http" })),
		);
		mount(connectorsPage);
		await showConnectors();

		fireEvent.click(within(await openAdd()).getByRole("button", { name: /HTTP endpoint/ }));
		const step = await screen.findByRole("dialog", { name: "HTTP endpoint" });
		fireEvent.change(within(step).getByLabelText("Name"), { target: { value: "Alerts" } });
		fireEvent.change(within(step).getByLabelText("Server URL"), {
			target: { value: "https://alerts.example.com/v2" },
		});
		fireEvent.click(within(step).getByRole("button", { name: "Add" }));

		await waitFor(() => expect(route.create).toHaveBeenCalledOnce());
		expect(route.create.mock.calls[0]?.[0]).toMatchObject({
			payload: { kind: "http", name: "Alerts", url: "https://alerts.example.com/v2" },
		});
		expect(route.create.mock.calls[0]?.[0].payload).not.toHaveProperty("secret");
	});

	it("tests a server by address before adding it", async () => {
		serveConnectors();
		route.testUnsaved.mockReturnValue(Effect.succeed({ reachable: true, latencyMs: 40, tools: 3 }));
		mount(connectorsPage);
		await showConnectors();

		fireEvent.click(within(await openAdd()).getByRole("button", { name: /Connect by URL/ }));
		const step = await screen.findByRole("dialog", { name: "Connect by URL" });
		fireEvent.change(within(step).getByLabelText("Server URL"), {
			target: { value: "https://wiki.example.com/mcp" },
		});
		fireEvent.change(within(step).getByLabelText("Access token"), { target: { value: "abc123" } });
		fireEvent.click(within(step).getByRole("button", { name: "Test" }));

		await within(step).findByText("Connector answered");
		expect(route.testUnsaved.mock.calls[0]?.[0]).toMatchObject({
			payload: {
				url: "https://wiki.example.com/mcp",
				secretHeader: "Authorization",
				secret: "Bearer abc123",
			},
		});
		expect(route.create).not.toHaveBeenCalled();
	});

	it("shows only the latest result once the way to sign in changes", async () => {
		serveConnectors();
		route.connectBuiltIn.mockReturnValue(
			Effect.fail(new BadRequest({ message: userText`The server didn't start a sign-in.` })),
		);
		mount(connectorsPage);
		await showConnectors();

		fireEvent.click(within(await openAdd()).getByRole("button", { name: /Connect by URL/ }));
		const step = await screen.findByRole("dialog", { name: "Connect by URL" });
		fireEvent.change(within(step).getByLabelText("Name"), { target: { value: "Wiki" } });
		fireEvent.change(within(step).getByLabelText("Server URL"), {
			target: { value: "https://wiki.example.com/mcp" },
		});
		fireEvent.click(within(step).getByRole("radio", { name: "Sign in" }));
		fireEvent.click(within(step).getByRole("button", { name: "Sign in" }));
		await within(step).findByText("The server didn't start a sign-in.");

		fireEvent.click(within(step).getByRole("radio", { name: "Token" }));

		expect(within(step).queryByRole("alert")).toBeNull();
	});

	it("adds a server by address through its own sign-in", async () => {
		const go = vi.spyOn(browser, "go").mockImplementation(() => undefined);
		serveConnectors();
		route.connectBuiltIn.mockReturnValue(
			Effect.succeed({ connectorId: wiki.id, authorizationUrl: "https://wiki.example/authorize" }),
		);
		mount(connectorsPage);
		await showConnectors();

		fireEvent.click(within(await openAdd()).getByRole("button", { name: /Connect by URL/ }));
		const step = await screen.findByRole("dialog", { name: "Connect by URL" });
		fireEvent.change(within(step).getByLabelText("Name"), { target: { value: "Wiki" } });
		fireEvent.change(within(step).getByLabelText("Server URL"), {
			target: { value: "https://wiki.example.com/mcp" },
		});
		fireEvent.click(within(step).getByRole("radio", { name: "Sign in" }));
		fireEvent.click(within(step).getByRole("button", { name: "Sign in" }));

		await waitFor(() => expect(go).toHaveBeenCalledWith("https://wiki.example/authorize"));
		expect(route.connectBuiltIn.mock.calls[0]?.[0]).toMatchObject({
			payload: { name: "Wiki", url: "https://wiki.example.com/mcp" },
		});
		expect(route.create).not.toHaveBeenCalled();
	});

	it("opens a connector on its own page, its tools apart by whether they make changes", async () => {
		serveConnectors(wikiAt("allow"));
		const { router } = mount(connectorsPage);
		await showConnectors();

		expect(screen.queryByText("Search pages")).toBeNull();
		fireEvent.click(
			await screen.findByRole("link", { name: "Wiki, Every tool runs without asking. Open tools" }),
		);
		await openedWiki();

		expect(router.state.location.pathname).toBe(wikiPage);
		screen.getByText("Connected by Sam");
		const reading = screen.getByRole("region", { name: "Tools that read" });
		within(reading).getByText("All 1 read tool");
		expect(
			(within(reading).getByRole("radio", { name: "Allowed" }) as HTMLInputElement).checked,
		).toBe(true);
		const changes = screen.getByRole("region", { name: "Tools that make changes" });
		within(changes).getByText("All 1 change tool");
		// Each tool is on Individual tools, not here.
		expect(screen.queryByText("search_pages")).toBeNull();
		// A server added by its address is told apart by it.
		screen.getByText(wiki.url);
		expect(
			screen
				.getAllByRole("link", { name: "Connectors" })
				.some((link) => link.getAttribute("href") === connectorsPage),
		).toBe(true);
	});

	it("opens a connector from its row, which offers nothing to change on the list", async () => {
		serveConnectors(wikiAt("ask"));
		const { router } = mount(connectorsPage);
		await showConnectors();

		const row = await screen.findByRole("article", { name: "Wiki" });
		// What its tools may do is set inside it, not from the bot's list.
		expect(within(row).queryByRole("button")).toBeNull();

		fireEvent.click(within(row).getByRole("link", { name: /^Wiki, / }));
		await openedWiki();
		expect(router.state.location.pathname).toBe(wikiPage);
	});

	it("sets one tool on its own on Individual tools, showing the change before the server answers", async () => {
		serveConnectors(wikiAt("ask"));
		route.update.mockReturnValue(Effect.never);
		mount(wikiPage);
		await openedWiki();

		await openIndividualTools();
		const wipe = screen.getByRole("group", { name: "wipe" });
		fireEvent.click(within(wipe).getByRole("radio", { name: "Off" }));

		await waitFor(() =>
			expect(route.update.mock.calls[0]?.[0]).toMatchObject({
				params: { projectId: linear.defaultProjectId, connectorId: wiki.id },
				payload: { toolAccess: { wipe: "off" } },
			}),
		);
		await waitFor(() =>
			expect(
				(
					within(screen.getByRole("group", { name: "wipe" })).getByRole("radio", {
						name: "Off",
					}) as HTMLInputElement
				).checked,
			).toBe(true),
		);
	});

	it("puts a tool back as it was when changing it fails", async () => {
		serveConnectors(wikiAt("ask"));
		route.update.mockReturnValue(Effect.fail(new BadRequest({ message: userText`Nope` })));
		mount(wikiPage);
		await openedWiki();

		await openIndividualTools();
		fireEvent.click(
			within(screen.getByRole("group", { name: "wipe" })).getByRole("radio", { name: "Off" }),
		);

		await screen.findByText("Nope");
		expect(
			(
				within(screen.getByRole("group", { name: "wipe" })).getByRole("radio", {
					name: "Ask first",
				}) as HTMLInputElement
			).checked,
		).toBe(true);
	});

	it("sets a kind of tool at once, leaving a tool set apart as it is", async () => {
		const [search, wipe] = wiki.tools;
		if (!search || !wipe) throw new Error("fixture");
		serveConnectors({
			...wiki,
			tools: [
				{ ...search, access: "allow" as const },
				{ ...wipe, access: "ask" as const },
				{ ...wipe, name: "wipe_more", access: "ask" as const },
				{ ...wipe, name: "wipe_all", access: "off" as const },
			],
		});
		route.update.mockReturnValue(Effect.never);
		mount(wikiPage);
		await openedWiki();

		// Most of the changes ask first, so that is the kind's setting; wipe_all is set apart from it.
		const changes = screen.getByRole("region", { name: "Tools that make changes" });
		expect(
			(within(changes).getByRole("radio", { name: "Ask first" }) as HTMLInputElement).checked,
		).toBe(true);
		screen.getByText("1 changed");
		fireEvent.click(within(changes).getByRole("radio", { name: "Allowed" }));

		await waitFor(() =>
			expect(route.update.mock.calls[0]?.[0]).toMatchObject({
				payload: { toolAccess: { wipe: "allow", wipe_more: "allow" } },
			}),
		);
		expect(route.update.mock.calls[0]?.[0].payload.toolAccess).not.toHaveProperty("wipe_all");
	});

	it("lists the tools set apart first, saying their kind's setting, and puts them all back", async () => {
		const [search, wipe] = wiki.tools;
		if (!search || !wipe) throw new Error("fixture");
		serveConnectors({
			...wiki,
			tools: [
				{ ...search, access: "allow" as const },
				{ ...wipe, access: "ask" as const },
				{ ...wipe, name: "wipe_more", access: "ask" as const },
				{ ...wipe, name: "wipe_all", access: "off" as const },
			],
		});
		route.update.mockReturnValue(Effect.never);
		mount(wikiPage);
		await openedWiki();

		await openIndividualTools();
		const changed = screen.getByRole("region", { name: "Changed (1)" });
		within(changed).getByRole("group", { name: "wipe_all" });
		within(changed).getByText("Default: ask first");
		screen.getByRole("region", { name: "Tools that make changes" });

		// Searching narrows every group.
		fireEvent.change(screen.getByRole("searchbox", { name: "Search tools" }), {
			target: { value: "more" },
		});
		await waitFor(() => expect(screen.queryByRole("region", { name: "Changed (1)" })).toBeNull());
		screen.getByRole("group", { name: "wipe_more" });
		fireEvent.change(screen.getByRole("searchbox", { name: "Search tools" }), {
			target: { value: "" },
		});

		fireEvent.click(await screen.findByRole("button", { name: "Reset all" }));
		await waitFor(() =>
			expect(route.update.mock.calls[0]?.[0]).toMatchObject({
				payload: { toolAccess: { wipe_all: "ask" } },
			}),
		);
	});

	it("goes back from Individual tools to the connector", async () => {
		serveConnectors(wikiAt("ask"));
		mount(wikiPage);
		await openedWiki();

		await openIndividualTools();
		fireEvent.click(screen.getByRole("button", { name: "Wiki" }));
		await screen.findByRole("region", { name: "Tools that read" });
		expect(screen.queryByRole("heading", { name: "Individual tools" })).toBeNull();
	});

	it("sums up on the bot's list what a connector's tools are set to", async () => {
		const [search, wipe] = wiki.tools;
		if (!search || !wipe) throw new Error("fixture");
		serveConnectors({
			...wiki,
			tools: [
				{ ...search, access: "allow" as const },
				{ ...wipe, access: "off" as const },
			],
		});
		mount(connectorsPage);
		await showConnectors();

		const row = await screen.findByRole("article", { name: "Wiki" });
		within(row).getByText("Custom: 1 allowed, 1 off");
	});

	it("offers nothing to set for a connector with no tools found yet", async () => {
		serveConnectors({ ...wiki, tools: [] });
		mount(connectorsPage);
		await showConnectors();

		const row = await screen.findByRole("article", { name: "Wiki" });
		within(row).getByText("No actions found yet");
		expect(within(row).queryByRole("button", { name: /all tools/ })).toBeNull();
	});

	it("takes a failing connector with no token to where one can be added", async () => {
		const failing = {
			...wikiAt("allow"),
			status: "error" as const,
			lastTestError: "The server needs an access token or a sign-in (HTTP 401)",
			secretHeader: null,
			hasSecret: false,
			appSettingsUrl: null,
		};
		serveConnectors(failing);
		route.update.mockReturnValue(Effect.succeed(listedConnector(failing)));
		mount(connectorsPage);
		await showConnectors();

		const row = await screen.findByRole("article", { name: "Wiki" });
		fireEvent.click(within(row).getByRole("button", { name: "Fix" }));
		await openedWiki();
		// Why, beside Test, with the way to fix it, so nothing moves under it.
		expect(screen.getByRole("alert").textContent).toMatch(/needs an access token/);
		screen.getByRole("link", { name: "How to fix this" });
		fireEvent.click(screen.getByRole("button", { name: "Add access token" }));
		fireEvent.change(screen.getByLabelText("Wiki secret"), { target: { value: "abc123" } });
		fireEvent.click(screen.getByRole("button", { name: "Save" }));

		await waitFor(() =>
			expect(route.update.mock.calls[0]?.[0]).toMatchObject({
				payload: { secretHeader: "Authorization", secret: "Bearer abc123" },
			}),
		);
	});

	it("tests, replaces the secret of and disconnects a connector from its page", async () => {
		serveConnectors({ ...wiki, hasSecret: true });
		route.test.mockReturnValue(Effect.succeed({ reachable: true, latencyMs: 12, tools: 2 }));
		route.update.mockReturnValue(Effect.succeed(listedConnector(wiki)));
		route.remove.mockImplementation(() => {
			serveConnectors();
			return Effect.void;
		});
		const { router } = mount(wikiPage);
		await openedWiki();

		fireEvent.click(screen.getByRole("button", { name: "Test connector" }));
		expect((await screen.findByRole("status")).textContent).toBe("Connector answered");

		fireEvent.click(screen.getByRole("button", { name: "Replace secret" }));
		fireEvent.change(screen.getByLabelText("Wiki secret"), { target: { value: "new-secret" } });
		fireEvent.click(screen.getByRole("button", { name: "Save" }));
		await waitFor(() =>
			expect(route.update).toHaveBeenCalledWith({
				params: { projectId: linear.defaultProjectId, connectorId: wiki.id },
				payload: { secret: "new-secret" },
			}),
		);

		fireEvent.click(screen.getByRole("button", { name: "Disconnect Wiki" }));
		await screen.findByRole("heading", { name: "Disconnect Wiki?" });
		fireEvent.click(within(screen.getByRole("dialog")).getByRole("button", { name: "Disconnect" }));
		await waitFor(() =>
			expect(route.remove).toHaveBeenCalledWith({
				params: { projectId: linear.defaultProjectId, connectorId: wiki.id },
			}),
		);
		await waitFor(() => expect(router.state.location.pathname).toBe(connectorsPage));
	});

	it("says so when the connector asked for is not the bot's", async () => {
		serveConnectors();
		mount(wikiPage);

		await screen.findByText("No such connector here");
	});

	it("lets an editor see connectors and their tools, with nothing to change", async () => {
		apiAnswers({ role: "editor" });
		serveConnectors(wiki);
		mount(connectorsPage);
		await showConnectors();

		const row = await screen.findByRole("article", { name: "Wiki" });
		expect(within(row).queryByRole("button")).toBeNull();
		expect(screen.queryByRole("button", { name: "Add connector" })).toBeNull();

		fireEvent.click(within(row).getByRole("link", { name: /^Wiki, / }));
		await openedWiki();
		expect(screen.queryByRole("radio")).toBeNull();
		expect(screen.queryByRole("button", { name: "Disconnect Wiki" })).toBeNull();
		screen.getByRole("button", { name: "Test connector" });
		expect(screen.queryByRole("button", { name: "Add secret" })).toBeNull();
		await openIndividualTools();
		expect(screen.getAllByText("search_pages").length).toBeGreaterThan(0);
		expect(screen.queryByRole("radio")).toBeNull();
		expect(screen.queryByRole("button", { name: "Reset all" })).toBeNull();
	});
});

describe("coming back from a connector sign-in", () => {
	it("opens the Connectors of the bot the sign-in was for", async () => {
		serveConnectors(wiki);
		const { router } = mount(
			`/connectors/oauth/return?workspace=${project.workspaceId}&project=${linear.defaultProjectId}`,
		);

		await screen.findByRole("article", { name: "Wiki" });
		expect(router.state.location.href).toBe(connectorsPage);
	});

	it("says once why a sign-in for a bot did not finish", async () => {
		serveConnectors(wiki);
		const { router } = mount(
			`/connectors/oauth/return?workspace=${project.workspaceId}&project=${linear.defaultProjectId}&oauth_error=refused`,
		);

		await screen.findByText(
			"Signing in did not finish: The server's sign-in was refused or cancelled.",
		);
		await waitFor(() => expect(router.state.location.href).toBe(connectorsPage));

		await router.navigate({
			to: "/$workspace/bots/$bot/connectors",
			params: { workspace: "suga", bot: triager.handle },
		});
		await screen.findByRole("navigation", { name: `${triager.name}'s pages` });
		await screen.findByRole("button", { name: "Add connector" });
		expect(screen.queryByText(/Signing in did not finish/)).toBeNull();
	});

	it("says what went wrong when the sign-in never reached a bot", async () => {
		mount("/connectors/oauth/return?oauth_error=unknown_state");

		await screen.findByText("The sign-in could not be found. Try again.");
		screen.getByRole("link", { name: "Return to workspace" });
	});

	it("never shows text from the address in place of a code", async () => {
		mount("/connectors/oauth/return?oauth_error=Call+555-0100+to+verify+your+account");

		await screen.findByText("Something went wrong. Try again.");
		expect(screen.queryByText(/555-0100/)).toBeNull();
	});
});
