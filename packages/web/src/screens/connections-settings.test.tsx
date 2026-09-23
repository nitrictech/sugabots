import type { Connection } from "@sugabots/contracts";
import { cleanup, fireEvent, screen, waitFor } from "@testing-library/react";
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
	enabled: false,
	allowMutating: false,
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

async function showConnections() {
	fireEvent.click(await screen.findByRole("tab", { name: "Connections" }));
}

describe("the Connections settings", () => {
	it.each([
		{ outcome: "success", query: "" },
		{ outcome: "failure", query: "&oauth_error=No+thanks" },
	])("opens Connections after OAuth $outcome", async ({ outcome, query }) => {
		const callbackPath = `${page}?tab=connections${query}`;
		const router = mount(callbackPath);
		await screen.findByRole("dialog", { name: "Workspace settings" });
		expect(await screen.findByRole("tab", { name: "Connections", selected: true })).toBeDefined();
		if (outcome === "failure") {
			expect(await screen.findByText("Signing in did not finish: No thanks")).toBeDefined();
		} else {
			expect(await screen.findByRole("heading", { name: "Connections" })).toBeDefined();
		}
		await waitFor(() => expect(router.state.location.href).toBe(`${page}?tab=connections`));
	});

	it("keeps pod tabs in the URL across navigation and reload", async () => {
		const router = mount(`${page}?tab=connections`);
		await screen.findByRole("tab", { name: "Connections", selected: true });
		fireEvent.click(screen.getByRole("tab", { name: "Routing" }));
		await waitFor(() => expect(router.state.location.href).toBe(`${page}?tab=routing`));
		expect(await screen.findByRole("tab", { name: "Routing", selected: true })).toBeDefined();
		fireEvent.click(screen.getByRole("tab", { name: "Team" }));
		await waitFor(() => expect(router.state.location.href).toBe(page));
		cleanup();
		mount(router.state.location.href);
		expect(await screen.findByRole("tab", { name: "Team", selected: true })).toBeDefined();
	});

	it("consumes an OAuth failure once and does not carry it into another pod", async () => {
		const router = mount(`${page}?tab=connections&oauth_error=No+thanks`);
		expect(await screen.findByText("Signing in did not finish: No thanks")).toBeDefined();
		await waitFor(() => expect(router.state.location.href).toBe(`${page}?tab=connections`));
		await router.navigate({
			to: "/$workspace/settings/pods/$pod",
			params: { workspace: "suga", pod: "sales" },
			search: { tab: "connections" },
		});
		await screen.findByRole("heading", { name: "Connections" });
		expect(screen.queryByText("Signing in did not finish: No thanks")).toBeNull();
	});

	it("connects a catalog service by signing in, with no key to paste", async () => {
		const go = vi.spyOn(browser, "go").mockImplementation(() => undefined);
		route.list.mockReturnValue(Effect.succeed([]));
		route.connectFromCatalog.mockReturnValue(
			Effect.succeed({
				connectionId: "0199a3a0-0000-7000-8000-0000000000f2",
				authorizationUrl: "https://notion.example/authorize?state=s-1",
			}),
		);
		mount(page);
		await showConnections();

		fireEvent.click(await screen.findByRole("button", { name: "Connect Notion" }));

		await waitFor(() =>
			expect(go).toHaveBeenCalledWith("https://notion.example/authorize?state=s-1"),
		);
		expect(route.connectFromCatalog.mock.calls[0]?.[0]).toMatchObject({
			payload: { name: "Notion", url: "https://mcp.notion.com/mcp" },
		});
		expect(route.create).not.toHaveBeenCalled();
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

		fireEvent.click(await screen.findByRole("button", { name: "Sign in" }));

		await waitFor(() => expect(go).toHaveBeenCalledWith("https://wiki.example/authorize"));
	});

	it("adds any other server by name and URL", async () => {
		route.list.mockReturnValue(Effect.succeed([]));
		route.create.mockImplementation(() => {
			route.list.mockReturnValue(Effect.succeed([wiki]));
			return Effect.succeed(wiki);
		});
		mount(page);
		await showConnections();

		fireEvent.click(await screen.findByRole("button", { name: "Connect by URL" }));
		fireEvent.change(await screen.findByLabelText("Name"), { target: { value: "Wiki" } });
		fireEvent.change(screen.getByLabelText("MCP server URL"), {
			target: { value: "https://wiki.example.com/mcp" },
		});
		fireEvent.click(screen.getByRole("button", { name: "Add" }));

		await waitFor(() => expect(route.create).toHaveBeenCalledOnce());
		expect(route.create.mock.calls[0]?.[0]).toMatchObject({
			payload: { name: "Wiki", url: "https://wiki.example.com/mcp", secretHeader: "Authorization" },
		});
		expect(await screen.findByRole("article", { name: "Wiki" })).toBeDefined();
	});

	it("explains the actions agents gain from a connection", async () => {
		route.list.mockReturnValue(Effect.succeed([wiki]));
		mount(page);
		await showConnections();

		expect(screen.queryByText("Search Pages")).toBeNull();
		fireEvent.click(await screen.findByRole("button", { name: "View tools" }));
		expect(await screen.findByText("Search Pages")).toBeDefined();
		expect(screen.getByText("Search the wiki for pages.")).toBeDefined();
		expect(screen.getByText("Makes changes")).toBeDefined();
	});

	it("turns a connection on for the pod", async () => {
		route.list.mockReturnValue(Effect.succeed([wiki]));
		route.update.mockImplementation(() => {
			route.list.mockReturnValue(Effect.succeed([{ ...wiki, enabled: true }]));
			return Effect.succeed({ ...wiki, enabled: true });
		});
		mount(page);
		await showConnections();
		expect(await screen.findByRole("button", { name: "Turn on" })).toBeDefined();

		fireEvent.click(screen.getByRole("button", { name: "Turn on" }));

		await waitFor(() => expect(route.update).toHaveBeenCalledOnce());
		expect(route.update.mock.calls[0]?.[0]).toMatchObject({
			params: { podId: pod.id, connectionId: wiki.id },
			payload: { enabled: true },
		});
		expect(await screen.findByRole("button", { name: "Turn off" })).toBeDefined();
	});

	it("lets the pod owner allow the tools that change things, off by default", async () => {
		route.list.mockReturnValue(Effect.succeed([wiki]));
		route.update.mockImplementation(() => {
			route.list.mockReturnValue(Effect.succeed([{ ...wiki, allowMutating: true }]));
			return Effect.succeed({ ...wiki, allowMutating: true });
		});
		mount(page);
		await showConnections();

		fireEvent.click(await screen.findByRole("button", { name: "Allow changes" }));

		await waitFor(() => expect(route.update).toHaveBeenCalledOnce());
		expect(route.update.mock.calls[0]?.[0]).toMatchObject({
			params: { podId: pod.id, connectionId: wiki.id },
			payload: { allowMutating: true },
		});
		expect(await screen.findByRole("button", { name: "Make read only" })).toBeDefined();
	});

	it("shows and revokes an agent's Always allow rule", async () => {
		route.list.mockReturnValue(Effect.succeed([wiki]));
		const rules = client.api.toolApprovals;
		rules.listRules.mockReturnValue(
			Effect.succeed([
				{
					id: "0199a3a0-0000-7000-8000-0000000000f2",
					agentId: linear.id,
					agentName: linear.name,
					connectionId: wiki.id,
					connectionName: wiki.name,
					toolName: "wipe",
					createdAt: "2026-09-14T00:00:00.000Z",
				},
			]),
		);
		rules.revokeRule.mockReturnValue(Effect.void);
		mount(page);
		await showConnections();
		fireEvent.click(await screen.findByRole("button", { name: "View tools" }));

		expect(await screen.findByText(`Always allowed for ${linear.name}`)).toBeDefined();
		fireEvent.click(screen.getByRole("button", { name: "Return to ask first" }));

		await waitFor(() => expect(rules.revokeRule).toHaveBeenCalledOnce());
		expect(rules.revokeRule).toHaveBeenCalledWith({
			params: { podId: pod.id, ruleId: "0199a3a0-0000-7000-8000-0000000000f2" },
		});
	});

	it("offers to reconnect a server whose last test failed", async () => {
		route.list.mockReturnValue(
			Effect.succeed([{ ...wiki, enabled: true, status: "error", lastTestError: "HTTP 401" }]),
		);
		route.test.mockReturnValue(Effect.succeed({ reachable: true, latencyMs: 40, tools: 2 }));
		mount(page);
		await showConnections();

		fireEvent.click(await screen.findByRole("button", { name: "Reconnect" }));

		await waitFor(() => expect(route.test).toHaveBeenCalledOnce());
		expect(await screen.findByText(/Found 2 actions/)).toBeDefined();
	});

	it("lets a pod member view connections without mutation controls", async () => {
		apiAnswers({ role: "member" });
		route.list.mockReturnValue(Effect.succeed([wiki]));
		mount(page);
		await showConnections();

		expect(await screen.findByRole("article", { name: "Wiki" })).toBeDefined();
		expect(screen.queryByRole("button", { name: "Wiki options" })).toBeNull();
		expect(screen.queryByRole("button", { name: "Connect Notion" })).toBeNull();
	});
});
