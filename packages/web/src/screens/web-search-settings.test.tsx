import type { SearchProvider } from "@sugabots/contracts";
import { cleanup, fireEvent, screen, waitFor, within } from "@testing-library/react";
import { Effect } from "effect";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { apiAnswers, linear, mount } from "@/test-api.tsx";
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
	lastTestedAt: null,
	lastTestError: null,
	createdAt: "2026-09-14T00:00:00.000Z",
};
const keyed: SearchProvider = {
	...brave,
	status: "untested",
	hasApiKey: true,
};
const exa: SearchProvider = {
	...brave,
	preset: "exa",
	name: "Exa",
	baseUrl: "https://api.exa.ai",
	status: "untested",
	enabled: true,
};

const searchSwitch = () => screen.findByRole("switch", { name: "Bots can use the web" });

function openAdvanced() {
	fireEvent.click(screen.getByRole("button", { name: "Show advanced" }));
	return screen.getByRole("group", { name: "Provider" });
}

beforeEach(() => {
	vi.clearAllMocks();
	apiAnswers();
});

afterEach(cleanup);

describe("the Web search settings", () => {
	it("switches on with Exa, and keeps the provider list under Advanced", async () => {
		route.get.mockReturnValue(Effect.succeed({ provider: null }));
		route.replace.mockImplementation(() => {
			route.get.mockReturnValue(Effect.succeed({ provider: exa }));
			return Effect.succeed(exa);
		});
		mount("/suga/settings/search");

		const power = await searchSwitch();
		expect(power.getAttribute("aria-checked")).toBe("false");
		expect(screen.queryByRole("group", { name: "Provider" })).toBeNull();
		fireEvent.click(power);

		await waitFor(() => expect(route.replace).toHaveBeenCalledOnce());
		expect(route.replace.mock.calls[0]?.[0]).toMatchObject({
			payload: { preset: "exa", enabled: true },
		});
		await waitFor(async () =>
			expect((await searchSwitch()).getAttribute("aria-checked")).toBe("true"),
		);

		const providers = openAdvanced();
		expect(within(providers).getByRole("radio", { name: /Exa/ })).toHaveProperty("checked", true);
		expect(screen.getByText(/Without one, searches use Exa's free tier/)).toBeDefined();
	});

	it("changes provider from the list, keeping the switch as it was", async () => {
		route.get.mockReturnValue(Effect.succeed({ provider: exa }));
		route.replace.mockImplementation(() => {
			route.get.mockReturnValue(Effect.succeed({ provider: brave }));
			return Effect.succeed(brave);
		});
		mount("/suga/settings/search");
		await searchSwitch();

		fireEvent.click(within(openAdvanced()).getByRole("radio", { name: /Brave Search/ }));

		await waitFor(() => expect(route.replace).toHaveBeenCalledOnce());
		expect(route.replace.mock.calls[0]?.[0]).toMatchObject({
			payload: { preset: "brave", enabled: true },
		});
		expect(await screen.findByRole("heading", { name: "Brave Search" })).toBeDefined();
		expect(screen.getByText("A key is required.")).toBeDefined();
	});

	it("holds the switch off until a provider that needs a key has one", async () => {
		route.get.mockReturnValue(Effect.succeed({ provider: brave }));
		route.update.mockImplementation((request: { payload: Record<string, unknown> }) => {
			const next = { ...keyed, enabled: request.payload.enabled === true };
			route.get.mockReturnValue(Effect.succeed({ provider: next }));
			return Effect.succeed(next);
		});
		mount("/suga/settings/search");

		expect(await searchSwitch()).toHaveProperty("disabled", true);
		expect(screen.getByText("Brave Search needs an API key first. Add it below.")).toBeDefined();
		const key = screen.getByLabelText("API key");
		key.focus();
		fireEvent.change(key, { target: { value: "brave-key" } });
		fireEvent.keyDown(key, { key: "Enter" });

		await waitFor(() => expect(route.update).toHaveBeenCalledOnce());
		expect(route.update.mock.calls[0]?.[0]).toMatchObject({ payload: { apiKey: "brave-key" } });
		expect(await screen.findByText("••••••••")).toBeDefined();

		const power = await searchSwitch();
		await waitFor(() => expect(power).toHaveProperty("disabled", false));
		fireEvent.click(power);

		await waitFor(() => expect(route.update).toHaveBeenCalledTimes(2));
		expect(route.update.mock.calls[1]?.[0]).toMatchObject({ payload: { enabled: true } });
	});

	it("removes a saved key after asking", async () => {
		route.get.mockReturnValue(Effect.succeed({ provider: keyed }));
		route.update.mockImplementation(() => {
			route.get.mockReturnValue(Effect.succeed({ provider: brave }));
			return Effect.succeed(brave);
		});
		mount("/suga/settings/search");
		await searchSwitch();
		openAdvanced();

		fireEvent.click(screen.getByRole("button", { name: "Remove" }));
		const dialog = await screen.findByRole("dialog", { name: "Remove the Brave Search key?" });
		expect(route.update).not.toHaveBeenCalled();
		fireEvent.click(within(dialog).getByRole("button", { name: "Remove" }));

		await waitFor(() =>
			expect(route.update.mock.calls[0]?.[0]).toMatchObject({ payload: { apiKey: null } }),
		);
		expect(await screen.findByPlaceholderText("Paste your key")).toBeDefined();
	});

	it("runs a test search and says how it went", async () => {
		route.get.mockReturnValue(Effect.succeed({ provider: keyed }));
		route.test.mockReturnValue(Effect.succeed({ reachable: true, latencyMs: 212, results: 8 }));
		mount("/suga/settings/search");
		await searchSwitch();
		openAdvanced();

		fireEvent.click(screen.getByRole("button", { name: /Test search/ }));

		expect(await screen.findByText("Search works")).toBeDefined();
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
