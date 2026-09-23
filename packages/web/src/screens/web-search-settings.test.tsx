import type { SearchProvider } from "@sugabots/contracts";
import { cleanup, fireEvent, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { apiAnswers, linear, mount, open } from "@/test-api.tsx";
import { client } from "@/test-client.ts";

vi.mock("@/api.ts", () => import("@/test-client.ts"));

const route = client.api.workspaces[":workspaceId"]["search-provider"];

const brave: SearchProvider = {
	id: "0199a3a0-0000-7000-8000-0000000000e1",
	workspaceId: linear.workspaceId,
	preset: "brave",
	name: "Brave Search",
	baseUrl: "https://api.search.brave.com/res/v1",
	enabled: false,
	status: "missing_key",
	hasApiKey: false,
	apiKeyHint: null,
	lastTestedAt: null,
	lastTestError: null,
	createdAt: "2026-09-14T00:00:00.000Z",
};
const keyed: SearchProvider = { ...brave, status: "untested", hasApiKey: true, apiKeyHint: "" };

beforeEach(() => {
	vi.clearAllMocks();
	apiAnswers();
});

afterEach(cleanup);

describe("the Web search settings", () => {
	it("switches on with Exa as the provider, then takes another from the dropdown", async () => {
		const exa: SearchProvider = {
			...brave,
			preset: "exa",
			name: "Exa",
			baseUrl: "https://api.exa.ai",
			status: "untested",
			enabled: true,
		};
		route.$get.mockResolvedValue(Response.json({ provider: null }));
		route.$put.mockImplementation(async (request: { json: { preset: string } }) => {
			const next = request.json.preset === "brave" ? brave : exa;
			route.$get.mockResolvedValue(Response.json({ provider: next }));
			return Response.json(next, { status: 201 });
		});
		mount("/settings/search");

		const power = await screen.findByRole("switch", { name: "Turn web search on" });
		expect(power).toHaveProperty("disabled", false);
		const picker = screen.getByRole("combobox", { name: "Search provider" });
		expect(picker.textContent).toContain("Exa");
		fireEvent.click(power);

		await waitFor(() => expect(route.$put).toHaveBeenCalledOnce());
		expect(route.$put.mock.calls[0]?.[0]).toMatchObject({ json: { preset: "exa", enabled: true } });
		expect(await screen.findByRole("switch", { name: "Turn web search off" })).toBeDefined();
		expect(screen.getByText(/Optional\. Without one, searches use Exa's free tier/)).toBeDefined();

		open(picker);
		(await screen.findByRole("option", { name: "Brave Search" })).click();

		await waitFor(() => expect(route.$put).toHaveBeenCalledTimes(2));
		expect(route.$put.mock.calls[1]?.[0]).toMatchObject({ json: { preset: "brave" } });
		expect(await screen.findByLabelText("Brave Search API key")).toBeDefined();
		expect(screen.getByText("Required.")).toBeDefined();
	});

	it("saves a key, after which the switch can be turned on", async () => {
		route.$get.mockResolvedValue(Response.json({ provider: brave }));
		route.$patch.mockImplementation(async (request: { json: Record<string, unknown> }) => {
			const next = { ...keyed, enabled: request.json.enabled === true };
			route.$get.mockResolvedValue(Response.json({ provider: next }));
			return Response.json(next);
		});
		mount("/settings/search");

		fireEvent.change(await screen.findByLabelText("Brave Search API key"), {
			target: { value: "brave-key" },
		});
		fireEvent.click(screen.getByRole("button", { name: "Save key" }));

		await waitFor(() => expect(route.$patch).toHaveBeenCalledOnce());
		expect(route.$patch.mock.calls[0]?.[0]).toMatchObject({ json: { apiKey: "brave-key" } });

		const power = await screen.findByRole("switch", { name: "Turn web search on" });
		await waitFor(() => expect(power).toHaveProperty("disabled", false));
		fireEvent.click(power);

		await waitFor(() => expect(route.$patch).toHaveBeenCalledTimes(2));
		expect(route.$patch.mock.calls[1]?.[0]).toMatchObject({ json: { enabled: true } });
		expect(await screen.findByRole("switch", { name: "Turn web search off" })).toBeDefined();
	});

	it("tells a member the pane is for administrators", async () => {
		apiAnswers({ role: "member" });
		mount("/settings/search");

		expect(
			await screen.findByText("Only workspace administrators can manage web search."),
		).toBeDefined();
		expect(route.$get).not.toHaveBeenCalled();
	});
});
