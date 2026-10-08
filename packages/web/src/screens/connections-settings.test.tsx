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
	auth: "header",
	signedIn: true,
	secretHeader: "authorization",
	hasSecret: false,
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

const wikiPage = `${page}/connections/${wiki.id}`;

/** The connection's own page, once it and its tools have loaded. */
async function openedWiki() {
	await screen.findByRole("heading", { name: "Wiki", level: 2 });
	await waitFor(() => expect(screen.queryByRole("status", { name: "Loading tools" })).toBeNull());
}

/** The pod page is one page, so its Connections are there once it has loaded. */
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
		mount(page);
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
		mount(page);
		await showConnections();

		const row = await screen.findByRole("article", { name: "Wiki" });
		expect(within(row).getByText("Not signed in yet")).toBeDefined();
		fireEvent.click(within(row).getByRole("button", { name: "Sign in" }));

		await waitFor(() => expect(go).toHaveBeenCalledWith("https://wiki.example/authorize"));
	});

	it("adds any other server by name and address", async () => {
		serveConnections();
		route.create.mockImplementation(() => {
			serveConnections(wiki);
			return Effect.succeed(listedConnection(wiki));
		});
		mount(page);
		await showConnections();

		fireEvent.click(within(await openAdd()).getByRole("button", { name: /Connect by URL/ }));
		const step = await screen.findByRole("dialog", { name: "Connect by URL" });
		fireEvent.change(within(step).getByLabelText("Name"), { target: { value: "Wiki" } });
		fireEvent.change(within(step).getByLabelText("Address"), {
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

	it("tests a server by address before adding it", async () => {
		serveConnections();
		route.testUnsaved.mockReturnValue(Effect.succeed({ reachable: true, latencyMs: 40, tools: 3 }));
		mount(page);
		await showConnections();

		fireEvent.click(within(await openAdd()).getByRole("button", { name: /Connect by URL/ }));
		const step = await screen.findByRole("dialog", { name: "Connect by URL" });
		fireEvent.change(within(step).getByLabelText("Address"), {
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
		mount(page);
		await showConnections();

		fireEvent.click(within(await openAdd()).getByRole("button", { name: /Connect by URL/ }));
		const step = await screen.findByRole("dialog", { name: "Connect by URL" });
		fireEvent.change(within(step).getByLabelText("Name"), { target: { value: "Wiki" } });
		fireEvent.change(within(step).getByLabelText("Address"), {
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
		mount(page);
		await showConnections();

		fireEvent.click(within(await openAdd()).getByRole("button", { name: /Connect by URL/ }));
		const step = await screen.findByRole("dialog", { name: "Connect by URL" });
		fireEvent.change(within(step).getByLabelText("Name"), { target: { value: "Wiki" } });
		fireEvent.change(within(step).getByLabelText("Address"), {
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
		const router = mount(page);
		await showConnections();

		expect(screen.queryByText("Search pages")).toBeNull();
		fireEvent.click(
			await screen.findByRole("link", { name: "Wiki, Every tool runs without asking. Open tools" }),
		);
		await openedWiki();

		expect(router.state.location.pathname).toBe(`${page}/connections/${wiki.id}`);
		const reading = screen.getByRole("region", { name: "Reading" });
		expect(within(reading).getByRole("group", { name: "Search pages" })).toBeDefined();
		// A tool is shown by its name alone.
		expect(within(reading).queryByText("Search the wiki for pages.")).toBeNull();
		expect(
			within(screen.getByRole("region", { name: "Making changes" })).getByRole("group", {
				name: "Wipe",
			}),
		).toBeDefined();
		// A server added by its address is told apart by it.
		expect(screen.getByText(wiki.url)).toBeDefined();
		const backBar = document.querySelector<HTMLElement>("[data-page-back]");
		expect(backBar && within(backBar).getByRole("link", { name: pod.name })).toBeDefined();
	});

	it("opens a connection from its row, but not from its menu", async () => {
		serveConnections(wikiAt("ask"));
		route.update.mockReturnValue(Effect.never);
		const router = mount(page);
		await showConnections();

		const row = await screen.findByRole("article", { name: "Wiki" });
		fireEvent.click(within(row).getByRole("button", { name: "Wiki, all tools: Ask" }));
		fireEvent.click(await screen.findByRole("menuitemradio", { name: "Allow" }));
		expect(router.state.location.pathname).toBe(page);

		fireEvent.click(within(row).getByRole("link", { name: /^Wiki, / }));
		await openedWiki();
		expect(router.state.location.pathname).toBe(wikiPage);
	});

	it("sets one tool on its own, showing the change before the server answers", async () => {
		serveConnections(wikiAt("ask"));
		route.update.mockReturnValue(Effect.never);
		mount(wikiPage);
		await openedWiki();

		const wipe = screen.getByRole("group", { name: "Wipe" });
		fireEvent.click(within(wipe).getByRole("radio", { name: "Off" }));

		await waitFor(() =>
			expect(route.update.mock.calls[0]?.[0]).toMatchObject({
				params: { podId: pod.id, connectionId: wiki.id },
				payload: { toolAccess: { wipe: "off" } },
			}),
		);
		await waitFor(() =>
			expect((within(wipe).getByRole("radio", { name: "Off" }) as HTMLInputElement).checked).toBe(
				true,
			),
		);
	});

	it("puts a tool back as it was when changing it fails", async () => {
		serveConnections(wikiAt("ask"));
		route.update.mockReturnValue(Effect.fail(new BadRequest({ message: userText`Nope` })));
		mount(wikiPage);
		await openedWiki();

		const wipe = screen.getByRole("group", { name: "Wipe" });
		fireEvent.click(within(wipe).getByRole("radio", { name: "Off" }));

		expect(await screen.findByText("Nope")).toBeDefined();
		expect((within(wipe).getByRole("radio", { name: "Ask" }) as HTMLInputElement).checked).toBe(
			true,
		);
	});

	it("sets every tool in a group from its menu, which reads Custom while they differ", async () => {
		const [search, wipe] = wiki.tools;
		if (!search || !wipe) throw new Error("fixture");
		const twoWipes = {
			...wiki,
			tools: [
				{ ...search, access: "allow" as const },
				{ ...wipe, access: "ask" as const },
				{ ...wipe, name: "wipe_all", access: "off" as const },
			],
		};
		serveConnections(twoWipes);
		route.update.mockReturnValue(Effect.never);
		mount(wikiPage);
		await openedWiki();

		const changes = screen.getByRole("region", { name: "Making changes" });
		fireEvent.click(within(changes).getByRole("button", { name: "Making changes tools: Custom" }));
		fireEvent.click(await screen.findByRole("menuitemradio", { name: "Ask" }));

		await waitFor(() =>
			expect(route.update.mock.calls[0]?.[0]).toMatchObject({
				payload: { toolAccess: { wipe: "ask", wipe_all: "ask" } },
			}),
		);
		expect(
			await within(changes).findByRole("button", { name: "Making changes tools: Ask" }),
		).toBeDefined();
	});

	it("folds a group away and opens it again", async () => {
		serveConnections(wikiAt("ask"));
		mount(wikiPage);
		await openedWiki();

		const reading = screen.getByRole("region", { name: "Reading" });
		fireEvent.click(within(reading).getByRole("button", { name: "Reading, 1 tool" }));
		expect(within(reading).queryByRole("group", { name: "Search pages" })).toBeNull();
		fireEvent.click(within(reading).getByRole("button", { name: "Reading, 1 tool" }));
		expect(within(reading).getByRole("group", { name: "Search pages" })).toBeDefined();
	});

	it("reads Custom on the pod's page for a connection whose tools differ, and sets them all from it", async () => {
		const [search, wipe] = wiki.tools;
		if (!search || !wipe) throw new Error("fixture");
		serveConnections({
			...wiki,
			tools: [
				{ ...search, access: "allow" as const },
				{ ...wipe, access: "off" as const },
			],
		});
		route.update.mockReturnValue(Effect.never);
		mount(page);
		await showConnections();

		const row = await screen.findByRole("article", { name: "Wiki" });
		expect(within(row).getByText("Custom: 1 allowed, 1 off")).toBeDefined();
		fireEvent.click(within(row).getByRole("button", { name: "Wiki, all tools: Custom" }));
		fireEvent.click(await screen.findByRole("menuitemradio", { name: "Ask" }));

		await waitFor(() =>
			expect(route.update.mock.calls[0]?.[0]).toMatchObject({ payload: { access: "ask" } }),
		);
		expect(await within(row).findByText("Every tool asks first")).toBeDefined();
	});

	it("opens the connection from the pod's page to set each tool, by choosing Custom", async () => {
		serveConnections(wikiAt("ask"));
		const router = mount(page);
		await showConnections();

		const row = await screen.findByRole("article", { name: "Wiki" });
		fireEvent.click(within(row).getByRole("button", { name: "Wiki, all tools: Ask" }));
		fireEvent.click(await screen.findByRole("menuitemradio", { name: "Custom" }));

		await openedWiki();
		expect(router.state.location.pathname).toBe(wikiPage);
		expect(route.update).not.toHaveBeenCalled();
	});

	it("offers nothing to set for a connection with no tools found yet", async () => {
		serveConnections({ ...wiki, tools: [] });
		mount(page);
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
		};
		serveConnections(failing);
		route.update.mockReturnValue(Effect.succeed(listedConnection(failing)));
		mount(page);
		await showConnections();

		const row = await screen.findByRole("article", { name: "Wiki" });
		fireEvent.click(within(row).getByRole("button", { name: "Fix" }));
		await openedWiki();
		expect(screen.getByText(/needs an access token/)).toBeDefined();
		fireEvent.click(screen.getByRole("button", { name: "Add access token" }));
		fireEvent.change(screen.getByLabelText("Wiki secret"), { target: { value: "abc123" } });
		fireEvent.click(screen.getByRole("button", { name: "Save" }));

		await waitFor(() =>
			expect(route.update.mock.calls[0]?.[0]).toMatchObject({
				payload: { secretHeader: "Authorization", secret: "Bearer abc123" },
			}),
		);
	});

	it("checks, replaces the secret of and disconnects a connection from its page's menu", async () => {
		serveConnections({ ...wiki, hasSecret: true });
		route.test.mockReturnValue(Effect.succeed({ reachable: true, latencyMs: 12, tools: 2 }));
		route.update.mockReturnValue(Effect.succeed(listedConnection(wiki)));
		route.remove.mockImplementation(() => {
			serveConnections();
			return Effect.void;
		});
		const router = mount(wikiPage);
		await openedWiki();

		fireEvent.click(screen.getByRole("button", { name: "More for Wiki" }));
		fireEvent.click(await screen.findByRole("menuitem", { name: "Check connection" }));
		expect(await screen.findByText("Connection successful")).toBeDefined();

		fireEvent.click(screen.getByRole("button", { name: "More for Wiki" }));
		fireEvent.click(await screen.findByRole("menuitem", { name: "Replace secret" }));
		fireEvent.change(screen.getByLabelText("Wiki secret"), { target: { value: "new-secret" } });
		fireEvent.click(screen.getByRole("button", { name: "Save" }));
		await waitFor(() =>
			expect(route.update).toHaveBeenCalledWith({
				params: { podId: pod.id, connectionId: wiki.id },
				payload: { secret: "new-secret" },
			}),
		);

		fireEvent.click(screen.getByRole("button", { name: "Disconnect" }));
		expect(await screen.findByRole("heading", { name: "Disconnect Wiki?" })).toBeDefined();
		fireEvent.click(within(screen.getByRole("dialog")).getByRole("button", { name: "Disconnect" }));
		await waitFor(() =>
			expect(route.remove).toHaveBeenCalledWith({
				params: { podId: pod.id, connectionId: wiki.id },
			}),
		);
		await waitFor(() => expect(router.state.location.pathname).toBe(page));
	});

	it("says so when the connection asked for is not in the pod", async () => {
		serveConnections();
		mount(wikiPage);

		expect(await screen.findByText("No such connection here")).toBeDefined();
	});

	it("lets a pod member see connections and their tools, with nothing to change", async () => {
		apiAnswers({ role: "member" });
		serveConnections(wiki);
		mount(page);
		await showConnections();

		const row = await screen.findByRole("article", { name: "Wiki" });
		expect(within(row).queryByRole("button", { name: /all tools/ })).toBeNull();
		expect(within(row).getByText("Off")).toBeDefined();
		expect(screen.queryByRole("button", { name: "Add connection" })).toBeNull();

		fireEvent.click(within(row).getByRole("link", { name: /^Wiki, / }));
		await openedWiki();
		expect(screen.getByText("Search pages")).toBeDefined();
		expect(screen.queryByRole("radio")).toBeNull();
		expect(screen.queryByRole("button", { name: "Disconnect" })).toBeNull();
		fireEvent.click(screen.getByRole("button", { name: "More for Wiki" }));
		expect(await screen.findByRole("menuitem", { name: "Check connection" })).toBeDefined();
		expect(screen.queryByRole("menuitem", { name: "Replace secret" })).toBeNull();
	});
});

describe("coming back from a connection sign-in", () => {
	it("opens the pod page of the pod the sign-in was for", async () => {
		serveConnections(wiki);
		const router = mount(`/connections/oauth/return?workspace=${pod.workspaceId}&pod=${pod.id}`);

		expect(await screen.findByRole("article", { name: "Wiki" })).toBeDefined();
		expect(router.state.location.href).toBe(page);
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
		await waitFor(() => expect(router.state.location.href).toBe(page));

		const other = pods[1] as (typeof pods)[number];
		await router.navigate({
			to: "/$workspace/settings/pods/$pod",
			params: { workspace: "suga", pod: other.slug },
		});
		expect(await screen.findByRole("heading", { name: other.name })).toBeDefined();
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
