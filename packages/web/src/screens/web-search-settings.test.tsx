import type { SearchProvider } from "@sugabots/contracts";
import { cleanup, fireEvent, screen, waitFor } from "@testing-library/react";
import { Effect } from "effect";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { apiAnswers, linear, mount, open } from "@/test-api.tsx";
import { client } from "@/test-client.ts";

vi.mock("@/api.ts", () => import("@/test-client.ts"));

const route = client.api.searchProviders;

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
		route.get.mockReturnValue(Effect.succeed({ provider: null }));
		route.replace.mockImplementation((request: { payload: { preset: string } }) => {
			const next = request.payload.preset === "brave" ? brave : exa;
			route.get.mockReturnValue(Effect.succeed({ provider: next }));
			return Effect.succeed(next);
		});
		mount("/suga/settings/search");

		const power = await screen.findByRole("switch", { name: "Turn web search on" });
		expect(power).toHaveProperty("disabled", false);
		const picker = screen.getByRole("combobox", { name: "Search provider" });
		expect(picker.textContent).toContain("Exa");
		fireEvent.click(power);

		await waitFor(() => expect(route.replace).toHaveBeenCalledOnce());
		expect(route.replace.mock.calls[0]?.[0]).toMatchObject({
			payload: { preset: "exa", enabled: true },
		});
		expect(await screen.findByRole("switch", { name: "Turn web search off" })).toBeDefined();
		expect(screen.getByText(/Optional\. Without one, searches use Exa's free tier/)).toBeDefined();

		open(picker);
		(await screen.findByRole("option", { name: "Brave Search" })).click();

		await waitFor(() => expect(route.replace).toHaveBeenCalledTimes(2));
		expect(route.replace.mock.calls[1]?.[0]).toMatchObject({ payload: { preset: "brave" } });
		expect(await screen.findByLabelText("Brave Search API key")).toBeDefined();
		expect(screen.getByText("Required.")).toBeDefined();
	});

	it("saves a key, after which the switch can be turned on", async () => {
		route.get.mockReturnValue(Effect.succeed({ provider: brave }));
		route.update.mockImplementation((request: { payload: Record<string, unknown> }) => {
			const next = { ...keyed, enabled: request.payload.enabled === true };
			route.get.mockReturnValue(Effect.succeed({ provider: next }));
			return Effect.succeed(next);
		});
		mount("/suga/settings/search");

		fireEvent.change(await screen.findByLabelText("Brave Search API key"), {
			target: { value: "brave-key" },
		});
		fireEvent.click(screen.getByRole("button", { name: "Save key" }));

		await waitFor(() => expect(route.update).toHaveBeenCalledOnce());
		expect(route.update.mock.calls[0]?.[0]).toMatchObject({ payload: { apiKey: "brave-key" } });

		const power = await screen.findByRole("switch", { name: "Turn web search on" });
		await waitFor(() => expect(power).toHaveProperty("disabled", false));
		fireEvent.click(power);

		await waitFor(() => expect(route.update).toHaveBeenCalledTimes(2));
		expect(route.update.mock.calls[1]?.[0]).toMatchObject({ payload: { enabled: true } });
		expect(await screen.findByRole("switch", { name: "Turn web search off" })).toBeDefined();
	});

	it("tells a member the pane is for administrators", async () => {
		apiAnswers({ role: "member" });
		mount("/suga/settings/search");

		expect(
			await screen.findByText("Only workspace administrators can manage web search."),
		).toBeDefined();
		expect(route.get).not.toHaveBeenCalled();
	});
});
