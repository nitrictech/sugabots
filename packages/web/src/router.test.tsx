import { cleanup, fireEvent, screen, waitFor, within } from "@testing-library/react";
import { Effect } from "effect";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { chooseWorkspace } from "@/lib/workspace.ts";
import {
	agents,
	apiAnswers,
	linear,
	mount,
	pendingAnswer,
	pods,
	triager,
	workspace,
} from "@/test-api.tsx";
import { client } from "@/test-client.ts";

vi.mock("@/api.ts", () => import("@/test-client.ts"));

beforeEach(() => {
	apiAnswers();
	chooseWorkspace(workspace.id);
});

afterEach(() => {
	cleanup();
	vi.restoreAllMocks();
	vi.clearAllMocks();
});

describe("slug addresses", () => {
	it("opens the URL's workspace regardless of the remembered workspace", async () => {
		const other = { id: "0199a3a0-0000-7000-8000-000000000099", name: "Acme", slug: "acme" };
		client.auth.workspaces.list.mockResolvedValue([workspace, other]);
		client.api.pods.list.mockImplementation(({ params }) =>
			Effect.succeed(
				params.workspaceId === other.id
					? pods.map((pod) => ({ ...pod, workspaceId: other.id }))
					: [],
			),
		);
		client.api.agents.list.mockImplementation(({ params }) =>
			Effect.succeed(
				params.workspaceId === other.id
					? agents.map((agent) => ({ ...agent, workspaceId: other.id }))
					: [],
			),
		);
		mount("/acme/pods/suga-team/agents/linear-handler");
		expect(await screen.findByRole("button", { name: /Acme/ })).toBeDefined();
		expect(await screen.findByRole("link", { name: "Configure Linear Handler" })).toBeDefined();
		expect(client.api.agents.list).toHaveBeenCalledExactlyOnceWith({
			params: { workspaceId: other.id },
		});
		expect(client.api.pods.list).toHaveBeenCalledExactlyOnceWith({
			params: { workspaceId: other.id },
		});
	});

	it("distinguishes matching handles in different pods and keeps API calls ID-based", async () => {
		const salesAgent = {
			...linear,
			id: "0199a3a0-0000-7000-8000-000000000099",
			podId: pods[1]?.id as string,
			name: "Sales Handler",
		};
		client.api.agents.list.mockReturnValue(Effect.succeed([...agents, salesAgent]));
		mount("/suga/pods/sales/agents/linear-handler");
		expect(await screen.findByRole("link", { name: "Configure Sales Handler" })).toBeDefined();
		expect(client.api.chats.getOrCreate).toHaveBeenCalledWith({
			params: { workspaceId: workspace.id },
			payload: { podId: salesAgent.podId, hostAgentId: salesAgent.id },
		});
	});

	it("reuses the roster when navigating between slug addresses", async () => {
		const router = mount("/suga/pods/suga-team/agents/linear-handler");
		expect(await screen.findByRole("link", { name: "Configure Linear Handler" })).toBeDefined();
		const rail = screen.getByRole("navigation", { name: "Workspace" });
		fireEvent.click(within(rail).getByRole("link", { name: triager.name }));
		await waitFor(() =>
			expect(router.state.location.pathname).toBe("/suga/pods/suga-team/agents/issue-triager"),
		);
		expect(await screen.findByRole("link", { name: "Configure Issue Triager" })).toBeDefined();
		expect(client.api.agents.list).toHaveBeenCalledTimes(1);
		expect(client.api.pods.list).toHaveBeenCalledTimes(1);
	});

	it("checks the server when a newly-created agent is missing from the cached roster", async () => {
		client.api.agents.list.mockReturnValue(
			Effect.succeed(agents.filter((agent) => agent.id !== linear.id)),
		);
		const router = mount("/suga/pods/suga-team/agents/issue-triager");
		await screen.findByRole("link", { name: "Configure Issue Triager" });
		client.api.agents.list.mockReturnValue(Effect.succeed(agents));
		client.api.agents.list.mockClear();
		await router.navigate({
			to: "/$workspace/pods/$pod/agents/$agent",
			params: { workspace: "suga", pod: "suga-team", agent: "linear-handler" },
		});
		expect(await screen.findByRole("link", { name: "Configure Linear Handler" })).toBeDefined();
		expect(client.api.agents.list).toHaveBeenCalledTimes(1);
	});

	it("checks the server when a newly-joined workspace is missing from cached memberships", async () => {
		const router = mount("/suga/settings");
		await screen.findByRole("dialog", { name: "Workspace settings" });
		client.auth.workspaces.list.mockResolvedValue([
			workspace,
			{ ...workspace, id: "0199a3a0-0000-7000-8000-000000000099", name: "Acme", slug: "acme" },
		]);
		await router.navigate({ to: "/$workspace/settings", params: { workspace: "acme" } });
		expect(await screen.findByRole("dialog", { name: "Workspace settings" })).toBeDefined();
		expect(
			within(screen.getByRole("dialog", { name: "Workspace settings" })).getAllByText("Acme"),
		).not.toHaveLength(0);
	});

	it("checks the server when a newly-created pod is missing from the cached list", async () => {
		client.api.pods.list.mockReturnValue(
			Effect.succeed(pods.filter((pod) => pod.slug === "sales")),
		);
		const router = mount("/suga/pods/sales/agents/customer-research");
		await screen.findByRole("link", { name: "Configure Customer Research" });
		client.api.pods.list.mockReturnValue(Effect.succeed(pods));
		await router.navigate({
			to: "/$workspace/settings/pods/$pod",
			params: { workspace: "suga", pod: "suga-team" },
		});
		expect(await screen.findByRole("heading", { name: "Suga-Team" })).toBeDefined();
	});

	it("opens a cached agent the next day while stale lists refresh in the background", async () => {
		const router = mount("/suga/pods/suga-team/agents/linear-handler");
		await screen.findByRole("link", { name: "Configure Linear Handler" });
		vi.spyOn(Date, "now").mockReturnValue(Date.now() + 24 * 60 * 60 * 1_000);
		const memberships = Promise.withResolvers<(typeof workspace)[]>();
		const podList = pendingAnswer();
		const agentList = pendingAnswer();
		client.auth.workspaces.list.mockReturnValue(memberships.promise);
		client.api.pods.list.mockReturnValue(podList.effect);
		client.api.agents.list.mockReturnValue(agentList.effect);
		const navigation = router.navigate({
			to: "/$workspace/pods/$pod/agents/$agent",
			params: { workspace: "suga", pod: "suga-team", agent: "issue-triager" },
		});
		try {
			expect(await screen.findByRole("link", { name: "Configure Issue Triager" })).toBeDefined();
			expect(client.auth.workspaces.list).toHaveBeenCalledTimes(2);
			expect(client.api.pods.list).toHaveBeenCalledTimes(2);
			expect(client.api.agents.list).toHaveBeenCalledTimes(2);
		} finally {
			memberships.resolve([workspace]);
			podList.answer(Effect.succeed(pods));
			agentList.answer(Effect.succeed(agents));
			await navigation;
		}
	});

	it("keeps a display-name change at the same address", async () => {
		client.api.agents.list.mockReturnValue(
			Effect.succeed(
				agents.map((agent) =>
					agent.id === linear.id ? { ...agent, name: "Release Assistant" } : agent,
				),
			),
		);
		const router = mount("/suga/pods/suga-team/agents/linear-handler");
		expect(await screen.findByRole("link", { name: "Configure Release Assistant" })).toBeDefined();
		expect(router.state.location.pathname).toBe("/suga/pods/suga-team/agents/linear-handler");
	});

	it("leaves an empty landing page when its background refresh finds the first agent", async () => {
		client.api.agents.list.mockReturnValue(Effect.succeed([]));
		const router = mount("/suga/agents");
		await screen.findByText("No agents yet");
		vi.spyOn(Date, "now").mockReturnValue(Date.now() + 24 * 60 * 60 * 1_000);
		client.api.agents.list.mockReturnValue(Effect.succeed(agents));
		await router.navigate({ to: "/$workspace/agents", params: { workspace: "suga" } });
		expect(await screen.findByRole("link", { name: "Configure Customer Research" })).toBeDefined();
	});

	it.each([
		["/missing/pods/suga-team/agents/linear-handler", "There is nothing at this address"],
		["/suga/pods/missing/agents/linear-handler", "No such agent here"],
		["/suga/pods/sales/agents/linear-handler", "No such agent here"],
	])("does not fall back to another resource for %s", async (path, message) => {
		mount(path);
		expect(await screen.findByText(message)).toBeDefined();
		expect(client.api.chats.getOrCreate).not.toHaveBeenCalled();
	});

	it("keeps a deep link through login, including its search parameters", async () => {
		const destination = "/suga/settings/pods/suga-team/agents/linear-handler?tab=routines";
		const router = mount(`/login?returnTo=${encodeURIComponent(destination)}`);
		await waitFor(() => expect(router.state.location.href).toBe(destination));
		expect(await screen.findByRole("tab", { name: "Routines", selected: true })).toBeDefined();
	});

	it("shows an OAuth callback failure and lets the user return to their workspace", async () => {
		const router = mount("/?oauth_error=The+sign-in+was+refused");
		expect(await screen.findByText("The sign-in was refused")).toBeDefined();
		fireEvent.click(screen.getByRole("link", { name: "Return to workspace" }));
		await waitFor(() =>
			expect(router.state.location.pathname).toBe("/suga/pods/sales/agents/customer-research"),
		);
		expect(router.state.location.search).not.toHaveProperty("oauth_error");
	});

	it("allows workspace and pod slugs that are also route names", async () => {
		client.auth.workspaces.list.mockResolvedValue([{ ...workspace, slug: "settings" }]);
		client.api.pods.list.mockReturnValue(
			Effect.succeed(
				pods.map((pod) => (pod.id === linear.podId ? { ...pod, slug: "settings" } : pod)),
			),
		);
		mount("/settings/pods/settings/agents/linear-handler");
		expect(await screen.findByRole("link", { name: "Configure Linear Handler" })).toHaveProperty(
			"pathname",
			"/settings/settings/pods/settings/agents/linear-handler",
		);
	});
});
