import type { ConnectionAccess } from "@sugabots/contracts";
import { BadRequest } from "@sugabots/contracts/http";
import { listedConnection, type TestConnection } from "@sugabots/contracts/testing";
import { userText } from "@sugabots/errors";
import { cleanup, fireEvent, screen, waitFor, within } from "@testing-library/react";
import { Effect } from "effect";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { browser } from "@/lib/connections.ts";
import { apiAnswers, linear, mount, pods, serveConnections } from "@/test-api.tsx";
import { client } from "@/test-client.ts";

vi.mock("@/api.ts", () => import("@/test-client.ts"));

const pod = pods[0] as (typeof pods)[number];
const page = `/suga/settings/pods/${pod.slug}`;
const route = client.api.connections;

const wiki: TestConnection = {
	id: "0199a3a0-0000-7000-8000-0000000000f1",
	workspaceId: linear.workspaceId,
	podId: pod.id,
	name: "Wiki",
	handle: "wiki",
	url: "https://wiki.wikimple.com/mcp",
	kind: "mcp",
	auth: "header",
	signedIn: true,
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
	lastTestedAt: "2026-09-14T00:00:01.000Z",
	lastTestError: null,
	connectedBy: "Sam",
	createdAt: "2026-09-14T00:00:00.000Z",
};

/** The Wiki with every one of its tools set to `access`. */
const wikiAt = (access: ConnectionAccess): TestConnection => ({
	...wiki,
	tools: wiki.tools.map((tool) => ({ ...tool, access })),
});

beforeEach(() => {
	vi.clearAllMocks();
	apiAnswers();
});

afterEach(cleanup);

/** The pod's Connections, a page of its own beside the pod's General. */
const connectionsPage = `${page}/connections`;
const wikiPage = `${connectionsPage}/${wiki.id}`;

/** The connection's own page, once it and its tools have loaded. */
async function openedWiki() {
	await screen.findByRole("heading", { name: "Wiki", level: 2 });
	await waitFor(() => expect(screen.queryByRole("status", { name: "Loading tools" })).toBeNull());
}

/** The connection's Individual tools, opened from its page. */
async function openIndividualTools() {
	fireEvent.click(screen.getByRole("button", { name: /^Individual tools/ }));
	await screen.findByRole("heading", { name: "Individual tools", level: 2 });
}

/** The pod's Connections page, once it has loaded. */
async function showConnections() {
	await screen.findByRole("heading", { name: "Connections" });
}

/** Opens Add connection, and the dialog it opens. */
async function openAdd() {
	fireEvent.click(await screen.findByRole("button", { name: "Add connection" }));
	return screen.findByRole("dialog", { name: `Add to ${pod.name}` });
}

describe("the Connections settings", () => {
	it("connects a catalog app by signing in, leaving its tools to start at their defaults", async () => {
		const go = vi.spyOn(browser, "go").mockImplementation(() => undefined);
		serveConnections();
		route.connectFromCatalog.mockReturnValue(
			Effect.succeed({
				connectionId: "0199a3a0-0000-7000-8000-0000000000f2",
				authorizationUrl: "https://notion.example/authorize?state=s-1",
			}),
		);
		mount(connectionsPage);
		await showConnections();

		const list = await openAdd();
		fireEvent.click(within(list).getByRole("button", { name: /^Notion/ }));
		const step = await screen.findByRole("dialog", { name: "Notion" });
		expect(within(step).queryByRole("radio")).toBeNull();
		fireEvent.click(within(step).getByRole("button", { name: /Connect Notion/ }));

		await waitFor(() =>
			expect(go).toHaveBeenCalledWith("https://notion.example/authorize?state=s-1"),
		);
		expect(route.connectFromCatalog.mock.calls[0]?.[0]).toMatchObject({
			payload: { name: "Notion", url: "https://mcp.notion.com/mcp" },
		});
		expect(route.update).not.toHaveBeenCalled();
		expect(route.create).not.toHaveBeenCalled();
	});

	it("offers to sign in a connection whose sign-in never finished", async () => {
		const go = vi.spyOn(browser, "go").mockImplementation(() => undefined);
		serveConnections({ ...wiki, auth: "oauth", signedIn: false, secretHeader: null });
		route.startOAuth.mockReturnValue(
			Effect.succeed({ authorizationUrl: "https://wiki.example/authorize" }),
		);
		mount(connectionsPage);
		await showConnections();

		const row = await screen.findByRole("article", { name: "Wiki" });
		expect(within(row).getByText("Not signed in yet")).toBeDefined();
		fireEvent.click(within(row).getByRole("button", { name: "Sign in" }));

		await waitFor(() => expect(go).toHaveBeenCalledWith("https://wiki.example/authorize"));
	});

	it("says on a connection's page who it is signed in as, or offers to sign it in", async () => {
		serveConnections({ ...wiki, auth: "oauth", signedIn: true, secretHeader: null });
		mount(`${page}/connections/${wiki.id}`);

		const account = await screen.findByRole("region", { name: "Account" });
		expect(within(account).getByText("Signed in as")).toBeDefined();
		expect(within(account).getByText("Sam")).toBeDefined();
		expect(within(account).queryByRole("button", { name: "Sign in" })).toBeNull();
		cleanup();

		serveConnections({ ...wiki, auth: "oauth", signedIn: false, secretHeader: null });
		mount(`${page}/connections/${wiki.id}`);

		const notYet = await screen.findByRole("region", { name: "Account" });
		expect(within(notYet).getByRole("button", { name: "Sign in" })).toBeDefined();
	});

	it("adds any other server by name and address", async () => {
		serveConnections();
		route.create.mockImplementation(() => {
			serveConnections(wiki);
			return Effect.succeed(listedConnection(wiki));
		});
		mount(connectionsPage);
		await showConnections();

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
		expect(await screen.findByRole("article", { name: "Wiki" })).toBeDefined();
		expect(route.update).not.toHaveBeenCalled();
	});

	it("adds an HTTP endpoint with no secret", async () => {
		serveConnections();
		route.create.mockImplementation(() =>
			Effect.succeed(listedConnection({ ...wiki, kind: "http" })),
		);
		mount(connectionsPage);
		await showConnections();

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
		serveConnections();
		route.testUnsaved.mockReturnValue(Effect.succeed({ reachable: true, latencyMs: 40, tools: 3 }));
		mount(connectionsPage);
		await showConnections();

		fireEvent.click(within(await openAdd()).getByRole("button", { name: /Connect by URL/ }));
		const step = await screen.findByRole("dialog", { name: "Connect by URL" });
		fireEvent.change(within(step).getByLabelText("Server URL"), {
			target: { value: "https://wiki.example.com/mcp" },
		});
		fireEvent.change(within(step).getByLabelText("Access token"), { target: { value: "abc123" } });
		fireEvent.click(within(step).getByRole("button", { name: "Test" }));

		expect(await within(step).findByText("Connection successful")).toBeDefined();
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
		serveConnections();
		route.connectFromCatalog.mockReturnValue(
			Effect.fail(new BadRequest({ message: userText`The server didn't start a sign-in.` })),
		);
		mount(connectionsPage);
		await showConnections();

		fireEvent.click(within(await openAdd()).getByRole("button", { name: /Connect by URL/ }));
		const step = await screen.findByRole("dialog", { name: "Connect by URL" });
		fireEvent.change(within(step).getByLabelText("Name"), { target: { value: "Wiki" } });
		fireEvent.change(within(step).getByLabelText("Server URL"), {
			target: { value: "https://wiki.example.com/mcp" },
		});
		fireEvent.click(within(step).getByRole("radio", { name: "Sign in" }));
		fireEvent.click(within(step).getByRole("button", { name: "Sign in" }));
		expect(await within(step).findByText("The server didn't start a sign-in.")).toBeDefined();

		fireEvent.click(within(step).getByRole("radio", { name: "Token" }));

		expect(within(step).queryByRole("alert")).toBeNull();
	});

	it("adds a server by address through its own sign-in", async () => {
		const go = vi.spyOn(browser, "go").mockImplementation(() => undefined);
		serveConnections();
		route.connectFromCatalog.mockReturnValue(
			Effect.succeed({ connectionId: wiki.id, authorizationUrl: "https://wiki.example/authorize" }),
		);
		mount(connectionsPage);
		await showConnections();

		fireEvent.click(within(await openAdd()).getByRole("button", { name: /Connect by URL/ }));
		const step = await screen.findByRole("dialog", { name: "Connect by URL" });
		fireEvent.change(within(step).getByLabelText("Name"), { target: { value: "Wiki" } });
		fireEvent.change(within(step).getByLabelText("Server URL"), {
			target: { value: "https://wiki.example.com/mcp" },
		});
		fireEvent.click(within(step).getByRole("radio", { name: "Sign in" }));
		fireEvent.click(within(step).getByRole("button", { name: "Sign in" }));

		await waitFor(() => expect(go).toHaveBeenCalledWith("https://wiki.example/authorize"));
		expect(route.connectFromCatalog.mock.calls[0]?.[0]).toMatchObject({
			payload: { name: "Wiki", url: "https://wiki.example.com/mcp" },
		});
		expect(route.create).not.toHaveBeenCalled();
	});

	it("opens a connection on its own page, its tools apart by whether they make changes", async () => {
		serveConnections(wikiAt("allow"));
		const router = mount(connectionsPage);
		await showConnections();

		expect(screen.queryByText("Search pages")).toBeNull();
		fireEvent.click(
			await screen.findByRole("link", { name: "Wiki, Every tool runs without asking. Open tools" }),
		);
		await openedWiki();

		expect(router.state.location.pathname).toBe(`${page}/connections/${wiki.id}`);
		expect(screen.getByText("Connected by Sam")).toBeDefined();
		const reading = screen.getByRole("region", { name: "Tools that read" });
		expect(within(reading).getByText("All 1 read tool")).toBeDefined();
		expect(
			(within(reading).getByRole("radio", { name: "Allowed" }) as HTMLInputElement).checked,
		).toBe(true);
		const changes = screen.getByRole("region", { name: "Tools that make changes" });
		expect(within(changes).getByText("All 1 change tool")).toBeDefined();
		// Each tool is on Individual tools, not here.
		expect(screen.queryByText("search_pages")).toBeNull();
		// A server added by its address is told apart by it.
		expect(screen.getByText(wiki.url)).toBeDefined();
		const backBar = document.querySelector<HTMLElement>("[data-page-back]");
		expect(backBar && within(backBar).getByRole("link", { name: "Connections" })).toBeDefined();
	});

	it("opens a connection from its row, which offers nothing to change on the list", async () => {
		serveConnections(wikiAt("ask"));
		const router = mount(connectionsPage);
		await showConnections();

		const row = await screen.findByRole("article", { name: "Wiki" });
		// What its tools may do is set inside it, not from the pod's list.
		expect(within(row).queryByRole("button")).toBeNull();

		fireEvent.click(within(row).getByRole("link", { name: /^Wiki, / }));
		await openedWiki();
		expect(router.state.location.pathname).toBe(wikiPage);
	});

	it("sets one tool on its own on Individual tools, showing the change before the server answers", async () => {
		serveConnections(wikiAt("ask"));
		route.update.mockReturnValue(Effect.never);
		mount(wikiPage);
		await openedWiki();

		await openIndividualTools();
		const wipe = screen.getByRole("group", { name: "wipe" });
		fireEvent.click(within(wipe).getByRole("radio", { name: "Off" }));

		await waitFor(() =>
			expect(route.update.mock.calls[0]?.[0]).toMatchObject({
				params: { podId: pod.id, connectionId: wiki.id },
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
		serveConnections(wikiAt("ask"));
		route.update.mockReturnValue(Effect.fail(new BadRequest({ message: userText`Nope` })));
		mount(wikiPage);
		await openedWiki();

		await openIndividualTools();
		fireEvent.click(
			within(screen.getByRole("group", { name: "wipe" })).getByRole("radio", { name: "Off" }),
		);

		expect(await screen.findByText("Nope")).toBeDefined();
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
		serveConnections({
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
		expect(screen.getByText("1 changed")).toBeDefined();
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
		serveConnections({
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
		expect(within(changed).getByRole("group", { name: "wipe_all" })).toBeDefined();
		expect(within(changed).getByText("Default: ask first")).toBeDefined();
		expect(screen.getByRole("region", { name: "Tools that make changes" })).toBeDefined();

		// Searching narrows every group.
		fireEvent.change(screen.getByRole("searchbox", { name: "Search tools" }), {
			target: { value: "more" },
		});
		await waitFor(() => expect(screen.queryByRole("region", { name: "Changed (1)" })).toBeNull());
		expect(screen.getByRole("group", { name: "wipe_more" })).toBeDefined();
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

	it("goes back from Individual tools to the connection", async () => {
		serveConnections(wikiAt("ask"));
		mount(wikiPage);
		await openedWiki();

		await openIndividualTools();
		const backBar = document.querySelector<HTMLElement>("[data-page-back]");
		if (backBar) fireEvent.click(within(backBar).getByRole("button", { name: "Wiki" }));
		expect(await screen.findByRole("heading", { name: "Wiki", level: 2 })).toBeDefined();
	});

	it("sums up on the pod's list what a connection's tools are set to", async () => {
		const [search, wipe] = wiki.tools;
		if (!search || !wipe) throw new Error("fixture");
		serveConnections({
			...wiki,
			tools: [
				{ ...search, access: "allow" as const },
				{ ...wipe, access: "off" as const },
			],
		});
		mount(connectionsPage);
		await showConnections();

		const row = await screen.findByRole("article", { name: "Wiki" });
		expect(within(row).getByText("Custom: 1 allowed, 1 off")).toBeDefined();
	});

	it("offers nothing to set for a connection with no tools found yet", async () => {
		serveConnections({ ...wiki, tools: [] });
		mount(connectionsPage);
		await showConnections();

		const row = await screen.findByRole("article", { name: "Wiki" });
		expect(within(row).getByText("No actions found yet")).toBeDefined();
		expect(within(row).queryByRole("button", { name: /all tools/ })).toBeNull();
	});

	it("takes a failing connection with no token to where one can be added", async () => {
		const failing = {
			...wikiAt("allow"),
			status: "error" as const,
			lastTestError: "The server needs an access token or a sign-in (HTTP 401)",
			secretHeader: null,
			hasSecret: false,
			appSettingsUrl: null,
		};
		serveConnections(failing);
		route.update.mockReturnValue(Effect.succeed(listedConnection(failing)));
		mount(connectionsPage);
		await showConnections();

		const row = await screen.findByRole("article", { name: "Wiki" });
		fireEvent.click(within(row).getByRole("button", { name: "Fix" }));
		await openedWiki();
		// Why, beside Test, with the way to fix it, so nothing moves under it.
		expect(screen.getByRole("alert").textContent).toMatch(/needs an access token/);
		expect(screen.getByRole("link", { name: "How to fix this" })).toBeDefined();
		fireEvent.click(screen.getByRole("button", { name: "Add access token" }));
		fireEvent.change(screen.getByLabelText("Wiki secret"), { target: { value: "abc123" } });
		fireEvent.click(screen.getByRole("button", { name: "Save" }));

		await waitFor(() =>
			expect(route.update.mock.calls[0]?.[0]).toMatchObject({
				payload: { secretHeader: "Authorization", secret: "Bearer abc123" },
			}),
		);
	});

	it("tests, replaces the secret of and disconnects a connection from its page", async () => {
		serveConnections({ ...wiki, hasSecret: true });
		route.test.mockReturnValue(Effect.succeed({ reachable: true, latencyMs: 12, tools: 2 }));
		route.update.mockReturnValue(Effect.succeed(listedConnection(wiki)));
		route.remove.mockImplementation(() => {
			serveConnections();
			return Effect.void;
		});
		const router = mount(wikiPage);
		await openedWiki();

		fireEvent.click(screen.getByRole("button", { name: "Test connection" }));
		expect((await screen.findByRole("status")).textContent).toBe("Connection successful");

		fireEvent.click(screen.getByRole("button", { name: "Replace secret" }));
		fireEvent.change(screen.getByLabelText("Wiki secret"), { target: { value: "new-secret" } });
		fireEvent.click(screen.getByRole("button", { name: "Save" }));
		await waitFor(() =>
			expect(route.update).toHaveBeenCalledWith({
				params: { podId: pod.id, connectionId: wiki.id },
				payload: { secret: "new-secret" },
			}),
		);

		fireEvent.click(screen.getByRole("button", { name: "Disconnect Wiki" }));
		expect(await screen.findByRole("heading", { name: "Disconnect Wiki?" })).toBeDefined();
		fireEvent.click(within(screen.getByRole("dialog")).getByRole("button", { name: "Disconnect" }));
		await waitFor(() =>
			expect(route.remove).toHaveBeenCalledWith({
				params: { podId: pod.id, connectionId: wiki.id },
			}),
		);
		await waitFor(() => expect(router.state.location.pathname).toBe(connectionsPage));
	});

	it("says so when the connection asked for is not in the pod", async () => {
		serveConnections();
		mount(wikiPage);

		expect(await screen.findByText("No such connection here")).toBeDefined();
	});

	it("lets a pod member see connections and their tools, with nothing to change", async () => {
		apiAnswers({ role: "member" });
		serveConnections(wiki);
		mount(connectionsPage);
		await showConnections();

		const row = await screen.findByRole("article", { name: "Wiki" });
		expect(within(row).queryByRole("button")).toBeNull();
		expect(screen.queryByRole("button", { name: "Add connection" })).toBeNull();

		fireEvent.click(within(row).getByRole("link", { name: /^Wiki, / }));
		await openedWiki();
		expect(screen.queryByRole("radio")).toBeNull();
		expect(screen.queryByRole("button", { name: "Disconnect Wiki" })).toBeNull();
		expect(screen.getByRole("button", { name: "Test connection" })).toBeDefined();
		expect(screen.queryByRole("button", { name: "Add secret" })).toBeNull();
		await openIndividualTools();
		expect(screen.getAllByText("search_pages").length).toBeGreaterThan(0);
		expect(screen.queryByRole("radio")).toBeNull();
		expect(screen.queryByRole("button", { name: "Reset all" })).toBeNull();
	});
});

describe("coming back from a connection sign-in", () => {
	it("opens the Connections of the pod the sign-in was for", async () => {
		serveConnections(wiki);
		const router = mount(`/connections/oauth/return?workspace=${pod.workspaceId}&pod=${pod.id}`);

		expect(await screen.findByRole("article", { name: "Wiki" })).toBeDefined();
		expect(router.state.location.href).toBe(connectionsPage);
	});

	it("says once why a sign-in for a pod did not finish", async () => {
		serveConnections(wiki);
		const router = mount(
			`/connections/oauth/return?workspace=${pod.workspaceId}&pod=${pod.id}&oauth_error=refused`,
		);

		expect(
			await screen.findByText(
				"Signing in did not finish: The server's sign-in was refused or cancelled.",
			),
		).toBeDefined();
		await waitFor(() => expect(router.state.location.href).toBe(connectionsPage));

		const other = pods[1] as (typeof pods)[number];
		await router.navigate({
			to: "/$workspace/settings/pods/$pod/$page",
			params: { workspace: "suga", pod: other.slug, page: "connections" },
		});
		expect(await screen.findByText(`Shared by every bot in ${other.name}.`)).toBeDefined();
		expect(screen.queryByText(/Signing in did not finish/)).toBeNull();
	});

	it("says what went wrong when the sign-in never reached a pod", async () => {
		mount("/connections/oauth/return?oauth_error=unknown_state");

		expect(await screen.findByText("The sign-in does not match any connection.")).toBeDefined();
		expect(screen.getByRole("link", { name: "Return to workspace" })).toBeDefined();
	});

	it("never shows text from the address in place of a code", async () => {
		mount("/connections/oauth/return?oauth_error=Call+555-0100+to+verify+your+account");

		expect(await screen.findByText("Something went wrong. Try again.")).toBeDefined();
		expect(screen.queryByText(/555-0100/)).toBeNull();
	});
});
