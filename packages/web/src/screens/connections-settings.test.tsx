import type { Connection } from "@sugabots/contracts";
import { cleanup, fireEvent, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { browser } from "@/lib/connections.ts";
import { apiAnswers, linear, mount, pods } from "@/test-api.tsx";
import { client } from "@/test-client.ts";

vi.mock("@/api.ts", () => import("@/test-client.ts"));

const pod = pods[0] as (typeof pods)[number];
const page = `/settings/pods/${pod.id}`;
const route = client.api.pods[":podId"].connections;

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
	it("connects a catalog service by signing in, with no key to paste", async () => {
		const go = vi.spyOn(browser, "go").mockImplementation(() => undefined);
		route.$get.mockImplementation(async () => Response.json([]));
		route.connect.$post.mockResolvedValue(
			Response.json(
				{
					connectionId: "0199a3a0-0000-7000-8000-0000000000f2",
					authorizationUrl: "https://notion.example/authorize?state=s-1",
				},
				{ status: 201 },
			),
		);
		mount(page);
		await showConnections();

		fireEvent.click(await screen.findByRole("button", { name: "Connect Notion" }));

		await waitFor(() =>
			expect(go).toHaveBeenCalledWith("https://notion.example/authorize?state=s-1"),
		);
		expect(route.connect.$post.mock.calls[0]?.[0]).toMatchObject({
			json: { name: "Notion", url: "https://mcp.notion.com/mcp" },
		});
		expect(route.$post).not.toHaveBeenCalled();
	});

	it("offers to sign in a connection whose sign-in never finished", async () => {
		const go = vi.spyOn(browser, "go").mockImplementation(() => undefined);
		route.$get.mockResolvedValue(
			Response.json([{ ...wiki, auth: "oauth", signedIn: false, secretHeader: null }]),
		);
		route[":connectionId"].oauth.start.$post.mockResolvedValue(
			Response.json({ authorizationUrl: "https://wiki.example/authorize" }),
		);
		mount(page);
		await showConnections();

		fireEvent.click(await screen.findByRole("button", { name: "Sign in" }));

		await waitFor(() => expect(go).toHaveBeenCalledWith("https://wiki.example/authorize"));
	});

	it("adds any other server by name and URL", async () => {
		route.$get.mockResolvedValue(Response.json([]));
		route.$post.mockImplementation(async () => {
			route.$get.mockResolvedValue(Response.json([wiki]));
			return Response.json(wiki, { status: 201 });
		});
		mount(page);
		await showConnections();

		fireEvent.click(await screen.findByRole("button", { name: "Connect by URL" }));
		fireEvent.change(await screen.findByLabelText("Name"), { target: { value: "Wiki" } });
		fireEvent.change(screen.getByLabelText("MCP server URL"), {
			target: { value: "https://wiki.example.com/mcp" },
		});
		fireEvent.click(screen.getByRole("button", { name: "Add" }));

		await waitFor(() => expect(route.$post).toHaveBeenCalledOnce());
		expect(route.$post.mock.calls[0]?.[0]).toMatchObject({
			json: { name: "Wiki", url: "https://wiki.example.com/mcp", secretHeader: "Authorization" },
		});
		expect(await screen.findByRole("article", { name: "Wiki" })).toBeDefined();
	});

	it("explains the actions agents gain from a connection", async () => {
		route.$get.mockResolvedValue(Response.json([wiki]));
		mount(page);
		await showConnections();

		expect(screen.queryByText("Search Pages")).toBeNull();
		fireEvent.click(await screen.findByRole("button", { name: "View tools" }));
		expect(await screen.findByText("Search Pages")).toBeDefined();
		expect(screen.getByText("Search the wiki for pages.")).toBeDefined();
		expect(screen.getByText("Makes changes")).toBeDefined();
	});

	it("turns a connection on for the pod", async () => {
		route.$get.mockResolvedValue(Response.json([wiki]));
		route[":connectionId"].$patch.mockImplementation(async () => {
			route.$get.mockResolvedValue(Response.json([{ ...wiki, enabled: true }]));
			return Response.json({ ...wiki, enabled: true });
		});
		mount(page);
		await showConnections();
		expect(await screen.findByRole("button", { name: "Turn on" })).toBeDefined();

		fireEvent.click(screen.getByRole("button", { name: "Turn on" }));

		await waitFor(() => expect(route[":connectionId"].$patch).toHaveBeenCalledOnce());
		expect(route[":connectionId"].$patch.mock.calls[0]?.[0]).toMatchObject({
			param: { podId: pod.id, connectionId: wiki.id },
			json: { enabled: true },
		});
		expect(await screen.findByRole("button", { name: "Turn off" })).toBeDefined();
	});

	it("lets the pod owner allow the tools that change things, off by default", async () => {
		route.$get.mockResolvedValue(Response.json([wiki]));
		route[":connectionId"].$patch.mockImplementation(async () => {
			route.$get.mockResolvedValue(Response.json([{ ...wiki, allowMutating: true }]));
			return Response.json({ ...wiki, allowMutating: true });
		});
		mount(page);
		await showConnections();

		fireEvent.click(await screen.findByRole("button", { name: "Allow changes" }));

		await waitFor(() => expect(route[":connectionId"].$patch).toHaveBeenCalledOnce());
		expect(route[":connectionId"].$patch.mock.calls[0]?.[0]).toMatchObject({
			param: { podId: pod.id, connectionId: wiki.id },
			json: { allowMutating: true },
		});
		expect(await screen.findByRole("button", { name: "Make read only" })).toBeDefined();
	});

	it("shows and revokes an agent's Always allow rule", async () => {
		route.$get.mockResolvedValue(Response.json([wiki]));
		const rules = client.api.pods[":podId"]["tool-approval-rules"];
		rules.$get.mockResolvedValue(
			Response.json([
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
		rules[":ruleId"].$delete.mockResolvedValue(new Response(null, { status: 204 }));
		mount(page);
		await showConnections();
		fireEvent.click(await screen.findByRole("button", { name: "View tools" }));

		expect(await screen.findByText(`Always allowed for ${linear.name}`)).toBeDefined();
		fireEvent.click(screen.getByRole("button", { name: "Return to ask first" }));

		await waitFor(() => expect(rules[":ruleId"].$delete).toHaveBeenCalledOnce());
		expect(rules[":ruleId"].$delete).toHaveBeenCalledWith({
			param: { podId: pod.id, ruleId: "0199a3a0-0000-7000-8000-0000000000f2" },
		});
	});

	it("offers to reconnect a server whose last test failed", async () => {
		// A response body reads once, and the test's success refetches the list.
		route.$get.mockImplementation(async () =>
			Response.json([{ ...wiki, enabled: true, status: "error", lastTestError: "HTTP 401" }]),
		);
		route[":connectionId"].test.$post.mockResolvedValue(
			Response.json({ reachable: true, latencyMs: 40, tools: 2 }),
		);
		mount(page);
		await showConnections();

		fireEvent.click(await screen.findByRole("button", { name: "Reconnect" }));

		await waitFor(() => expect(route[":connectionId"].test.$post).toHaveBeenCalledOnce());
		expect(await screen.findByText(/Found 2 actions/)).toBeDefined();
	});

	it("lets a pod member view connections without mutation controls", async () => {
		apiAnswers({ role: "member" });
		route.$get.mockResolvedValue(Response.json([wiki]));
		mount(page);
		await showConnections();

		expect(await screen.findByRole("article", { name: "Wiki" })).toBeDefined();
		expect(screen.queryByRole("button", { name: "Wiki options" })).toBeNull();
		expect(screen.queryByRole("button", { name: "Connect Notion" })).toBeNull();
	});
});
