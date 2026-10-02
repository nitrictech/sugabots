import type { Connection } from "@sugabots/contracts";
import { cleanup, fireEvent, screen, waitFor, within } from "@testing-library/react";
import { Effect } from "effect";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { browser } from "@/lib/connections.ts";
import { apiAnswers, linear, mount, pods } from "@/test-api.tsx";
import { client } from "@/test-client.ts";

vi.mock("@/api.ts", () => import("@/test-client.ts"));

const pod = pods[0] as (typeof pods)[number];
const page = `/suga/settings/pods/${pod.slug}`;
const route = client.api.connections;

const wiki: Connection = {
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
	access: "off",
	status: "connected",
	tools: [
		{
			name: "search_pages",
			description: "Search the wiki for pages.",
			readOnly: true,
			destructive: null,
		},
		{ name: "wipe", description: "Removes it all.", readOnly: false, destructive: true },
	],
	lastTestedAt: "2026-09-14T00:00:01.000Z",
	lastTestError: null,
	createdAt: "2026-09-14T00:00:00.000Z",
};

beforeEach(() => {
	vi.clearAllMocks();
	apiAnswers();
});

afterEach(cleanup);

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
	it("connects a catalog app by signing in, asking first unless told otherwise", async () => {
		const go = vi.spyOn(browser, "go").mockImplementation(() => undefined);
		route.list.mockReturnValue(Effect.succeed([]));
		route.connectFromCatalog.mockReturnValue(
			Effect.succeed({
				connectionId: "0199a3a0-0000-7000-8000-0000000000f2",
				authorizationUrl: "https://notion.example/authorize?state=s-1",
			}),
		);
		route.update.mockReturnValue(Effect.succeed({ ...wiki, access: "ask" }));
		mount(page);
		await showConnections();

		const list = await openAdd();
		fireEvent.click(within(list).getByRole("button", { name: /^Notion/ }));
		const step = await screen.findByRole("dialog", { name: "Notion" });
		expect((within(step).getByRole("radio", { name: "Ask" }) as HTMLInputElement).checked).toBe(
			true,
		);
		expect(within(step).queryByRole("radio", { name: "Off" })).toBeNull();
		fireEvent.click(within(step).getByRole("button", { name: /Connect Notion/ }));

		await waitFor(() =>
			expect(go).toHaveBeenCalledWith("https://notion.example/authorize?state=s-1"),
		);
		expect(route.connectFromCatalog.mock.calls[0]?.[0]).toMatchObject({
			payload: { name: "Notion", url: "https://mcp.notion.com/mcp" },
		});
		expect(route.update.mock.calls[0]?.[0]).toMatchObject({
			params: { podId: pod.id, connectionId: "0199a3a0-0000-7000-8000-0000000000f2" },
			payload: { access: "ask" },
		});
		expect(route.create).not.toHaveBeenCalled();
	});

	it("leaves a catalog app to start at Allow when that is chosen", async () => {
		const go = vi.spyOn(browser, "go").mockImplementation(() => undefined);
		route.list.mockReturnValue(Effect.succeed([]));
		route.connectFromCatalog.mockReturnValue(
			Effect.succeed({
				connectionId: "0199a3a0-0000-7000-8000-0000000000f2",
				authorizationUrl: "https://notion.example/authorize",
			}),
		);
		mount(page);
		await showConnections();

		fireEvent.click(within(await openAdd()).getByRole("button", { name: /^Notion/ }));
		const step = await screen.findByRole("dialog", { name: "Notion" });
		fireEvent.click(within(step).getByRole("radio", { name: "Allow" }));
		fireEvent.click(within(step).getByRole("button", { name: /Connect Notion/ }));

		await waitFor(() => expect(go).toHaveBeenCalled());
		expect(route.update).not.toHaveBeenCalled();
	});

	it("offers to sign in a connection whose sign-in never finished", async () => {
		const go = vi.spyOn(browser, "go").mockImplementation(() => undefined);
		route.list.mockReturnValue(
			Effect.succeed([{ ...wiki, auth: "oauth", signedIn: false, secretHeader: null }]),
		);
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

	it("adds any other server by name and address, with its approval", async () => {
		route.list.mockReturnValue(Effect.succeed([]));
		route.create.mockImplementation(() => {
			route.list.mockReturnValue(Effect.succeed([wiki]));
			return Effect.succeed(wiki);
		});
		route.update.mockReturnValue(Effect.succeed({ ...wiki, access: "ask" }));
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
		// A server added by address starts at Allow; the dialog asks first unless told otherwise.
		await waitFor(() =>
			expect(route.update.mock.calls[0]?.[0]).toMatchObject({
				params: { podId: pod.id, connectionId: wiki.id },
				payload: { access: "ask" },
			}),
		);
		expect(await screen.findByRole("article", { name: "Wiki" })).toBeDefined();
	});

	it("tests a server by address before adding it", async () => {
		route.list.mockReturnValue(Effect.succeed([]));
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

		expect(await within(step).findByText("Found 3 actions in 40 ms.")).toBeDefined();
		expect(route.testUnsaved.mock.calls[0]?.[0]).toMatchObject({
			payload: {
				url: "https://wiki.example.com/mcp",
				secretHeader: "Authorization",
				secret: "Bearer abc123",
			},
		});
		expect(route.create).not.toHaveBeenCalled();
	});

	it("adds a server by address through its own sign-in", async () => {
		const go = vi.spyOn(browser, "go").mockImplementation(() => undefined);
		route.list.mockReturnValue(Effect.succeed([]));
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

	it("opens a connection to show its tools, grouped by whether they ask first", async () => {
		route.list.mockReturnValue(Effect.succeed([{ ...wiki, access: "allow" }]));
		mount(page);
		await showConnections();

		expect(screen.queryByText("Search pages")).toBeNull();
		fireEvent.click(await screen.findByRole("button", { name: "About Wiki" }));
		const dialog = await screen.findByRole("dialog", { name: "Wiki" });
		const asks = within(dialog).getByRole("heading", { name: "Asks first" }).closest("section");
		const free = within(dialog).getByRole("heading", { name: "Runs freely" }).closest("section");
		if (!asks || !free) throw new Error("tool groups not found");
		expect(within(asks).getByText("Wipe")).toBeDefined();
		expect(within(free).getByText("Search pages")).toBeDefined();
		expect(within(free).getByText("Search the wiki for pages.")).toBeDefined();
	});

	it("puts every tool under Asks first when the connection asks", async () => {
		route.list.mockReturnValue(Effect.succeed([{ ...wiki, access: "ask" }]));
		mount(page);
		await showConnections();

		fireEvent.click(await screen.findByRole("button", { name: "About Wiki" }));
		const dialog = await screen.findByRole("dialog", { name: "Wiki" });

		expect(within(dialog).queryByRole("heading", { name: "Runs freely" })).toBeNull();
		const asks = within(dialog).getByRole("heading", { name: "Asks first" }).closest("section");
		expect(asks && within(asks).getByText("Search pages")).toBeDefined();
	});

	it("sets what the pod's bots may do with a connection", async () => {
		route.list.mockReturnValue(Effect.succeed([wiki]));
		route.update.mockImplementation(() => {
			route.list.mockReturnValue(Effect.succeed([{ ...wiki, access: "ask" }]));
			return Effect.succeed({ ...wiki, access: "ask" });
		});
		mount(page);
		await showConnections();
		const access = await screen.findByRole("group", { name: "What bots may do with Wiki" });
		expect((within(access).getByRole("radio", { name: "Off" }) as HTMLInputElement).checked).toBe(
			true,
		);

		fireEvent.click(within(access).getByRole("radio", { name: "Ask" }));

		await waitFor(() => expect(route.update).toHaveBeenCalledOnce());
		expect(route.update.mock.calls[0]?.[0]).toMatchObject({
			params: { podId: pod.id, connectionId: wiki.id },
			payload: { access: "ask" },
		});
		await waitFor(() =>
			expect((within(access).getByRole("radio", { name: "Ask" }) as HTMLInputElement).checked).toBe(
				true,
			),
		);
	});

	it("takes a failing connection with no token to where one can be added", async () => {
		const failing = {
			...wiki,
			access: "allow" as const,
			status: "error" as const,
			lastTestError: "The server needs an access token or a sign-in (HTTP 401)",
			secretHeader: null,
			hasSecret: false,
		};
		route.list.mockReturnValue(Effect.succeed([failing]));
		route.update.mockReturnValue(Effect.succeed(failing));
		mount(page);
		await showConnections();

		const row = await screen.findByRole("article", { name: "Wiki" });
		fireEvent.click(within(row).getByRole("button", { name: "Fix" }));
		const dialog = await screen.findByRole("dialog", { name: "Wiki" });
		expect(within(dialog).getByText(/needs an access token/)).toBeDefined();
		fireEvent.click(within(dialog).getByRole("button", { name: "Add" }));
		fireEvent.change(within(dialog).getByLabelText("Wiki secret"), { target: { value: "abc123" } });
		fireEvent.click(within(dialog).getByRole("button", { name: "Save" }));

		await waitFor(() =>
			expect(route.update.mock.calls[0]?.[0]).toMatchObject({
				payload: { secretHeader: "Authorization", secret: "Bearer abc123" },
			}),
		);
	});

	it("checks, replaces the secret of and removes a connection from its own page", async () => {
		route.list.mockReturnValue(Effect.succeed([{ ...wiki, hasSecret: true }]));
		route.test.mockReturnValue(Effect.succeed({ reachable: true, latencyMs: 12, tools: 2 }));
		route.update.mockReturnValue(Effect.succeed(wiki));
		route.remove.mockReturnValue(Effect.void);
		mount(page);
		await showConnections();

		fireEvent.click(await screen.findByRole("button", { name: "About Wiki" }));
		const dialog = await screen.findByRole("dialog", { name: "Wiki" });
		fireEvent.click(within(dialog).getByRole("button", { name: "Check" }));
		expect(await within(dialog).findByText(/Found 2 actions in 12 ms/)).toBeDefined();

		fireEvent.click(within(dialog).getByRole("button", { name: "Replace" }));
		fireEvent.change(within(dialog).getByLabelText("Wiki secret"), {
			target: { value: "new-secret" },
		});
		fireEvent.click(within(dialog).getByRole("button", { name: "Save" }));
		await waitFor(() =>
			expect(route.update).toHaveBeenCalledWith({
				params: { podId: pod.id, connectionId: wiki.id },
				payload: { secret: "new-secret" },
			}),
		);

		fireEvent.click(within(dialog).getByRole("button", { name: "Remove connection" }));
		expect(await screen.findByRole("heading", { name: "Remove Wiki?" })).toBeDefined();
		fireEvent.click(screen.getByRole("button", { name: "Remove" }));
		await waitFor(() =>
			expect(route.remove).toHaveBeenCalledWith({
				params: { podId: pod.id, connectionId: wiki.id },
			}),
		);
	});

	it("lets a pod member see connections and their tools, with nothing to change", async () => {
		apiAnswers({ role: "member" });
		route.list.mockReturnValue(Effect.succeed([wiki]));
		mount(page);
		await showConnections();

		const row = await screen.findByRole("article", { name: "Wiki" });
		expect(within(row).queryByRole("group", { name: "What bots may do with Wiki" })).toBeNull();
		expect(within(row).getByText("Off")).toBeDefined();
		expect(screen.queryByRole("button", { name: "Add connection" })).toBeNull();

		fireEvent.click(within(row).getByRole("button", { name: "About Wiki" }));
		const dialog = await screen.findByRole("dialog", { name: "Wiki" });
		expect(within(dialog).getByText("Search pages")).toBeDefined();
		expect(within(dialog).queryByRole("button", { name: "Remove connection" })).toBeNull();
		expect(within(dialog).queryByRole("button", { name: "Replace" })).toBeNull();
	});
});

describe("coming back from a connection sign-in", () => {
	it("opens the pod page of the pod the sign-in was for", async () => {
		route.list.mockReturnValue(Effect.succeed([wiki]));
		const router = mount(`/connections/oauth/return?workspace=${pod.workspaceId}&pod=${pod.id}`);

		expect(await screen.findByRole("article", { name: "Wiki" })).toBeDefined();
		expect(router.state.location.href).toBe(page);
	});

	it("says once why a sign-in for a pod did not finish", async () => {
		route.list.mockReturnValue(Effect.succeed([wiki]));
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
