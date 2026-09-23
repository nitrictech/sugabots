import type { NewSearchProvider, SearchProvider, SearchProviderUpdate } from "@sugabots/contracts";
import { searchProviderPreset } from "@sugabots/contracts";
import { createEgressUrlValidator } from "@sugabots/core/providers/network/egress";
import type { SearchProviderStore } from "@sugabots/core/providers/search-providers/store";
import { testAuthorization } from "@sugabots/core/workspaces/testing";
import { Effect } from "effect";
import { describe, expect, it, vi } from "vitest";
import type { SessionResolver } from "../../auth/session.ts";
import { createTestApp } from "../../http/app.test-support.ts";

const WORKSPACE_ID = "0199a3a0-0000-7000-8000-000000000001";
const USER_ID = "0199a3a0-0000-7000-8000-000000000002";
const root = `/workspaces/${WORKSPACE_ID}/search-provider`;
const headers = { authorization: "Bearer good-token", "content-type": "application/json" };

const resolveSession: SessionResolver = async (requestHeaders) =>
	requestHeaders.get("authorization") === "Bearer good-token"
		? { user: { id: USER_ID, name: "Sam", email: "sam@example.com", image: null } }
		: null;

const authorization = testAuthorization({
	id: WORKSPACE_ID,
	roles: { [USER_ID]: "admin" },
});

function stored(input: NewSearchProvider, extra: Partial<SearchProvider> = {}): SearchProvider {
	const preset = searchProviderPreset(input.preset);
	return {
		id: "0199a3a0-0000-7000-8000-000000000003",
		workspaceId: WORKSPACE_ID,
		preset: input.preset,
		name: preset.name,
		baseUrl: input.baseUrl ?? preset.baseUrl,
		enabled: false,
		status: input.apiKey || !preset.requiresApiKey ? "untested" : "missing_key",
		hasApiKey: input.apiKey !== undefined,
		apiKeyHint: input.apiKey === undefined ? null : "",
		lastTestedAt: null,
		lastTestError: null,
		createdAt: "2026-09-14T00:00:00.000Z",
		...extra,
	};
}

function routes(
	allowPrivateNetwork: boolean,
	current: SearchProvider | undefined,
	search = vi.fn(async () =>
		Response.json({ web: { results: [{ title: "t", url: "https://r" }] } }),
	),
) {
	let provider = current;
	const replace = vi.fn((_workspaceId: string, _userId: string, input: NewSearchProvider) =>
		Effect.sync(() => {
			provider = stored(input);
			return provider;
		}),
	);
	const update = vi.fn((_workspaceId: string, input: SearchProviderUpdate) =>
		Effect.sync(() => {
			if (!provider) return undefined;
			provider = {
				...provider,
				enabled: input.enabled ?? provider.enabled,
				hasApiKey: input.apiKey === undefined ? provider.hasApiKey : input.apiKey !== null,
			};
			return provider;
		}),
	);
	const recordTest = vi.fn(() => Effect.void);
	const store: SearchProviderStore = {
		get: () => Effect.sync(() => provider),
		replace,
		update,
		remove: () => Effect.sync(() => provider !== undefined),
		connection: () =>
			Effect.sync(() =>
				provider?.hasApiKey || provider?.preset === "searxng"
					? {
							preset: provider.preset,
							baseUrl: provider.baseUrl,
							apiKey: provider.hasApiKey ? "key" : undefined,
							configurationUpdatedAt: new Date("2026-09-14T00:00:00.000Z"),
						}
					: undefined,
			),
		resolve: () => Effect.die(new Error("routes do not resolve")),
		recordTest,
	};
	const app = createTestApp({
		resolveSession,
		authorization,
		stores: { searchProviders: store },
		httpClients: { for: () => search as unknown as typeof fetch },
		validateProviderUrl: createEgressUrlValidator({ allowPrivateNetwork }),
	});
	return { app, replace, update, recordTest, search };
}

describe("a workspace's search provider", () => {
	it("answers null when the workspace has none", async () => {
		const { app } = routes(true, undefined);

		const response = await app.request(root, { headers });

		expect(response.status).toBe(200);
		expect(await response.json()).toEqual({ provider: null });
	});

	it("sets a provider from the catalog with only its key", async () => {
		const { app, replace } = routes(true, undefined);

		const response = await app.request(root, {
			method: "PUT",
			headers,
			body: JSON.stringify({ preset: "brave", apiKey: "brave-key" }),
		});

		expect(response.status).toBe(201);
		expect(replace).toHaveBeenCalledWith(WORKSPACE_ID, USER_ID, {
			preset: "brave",
			apiKey: "brave-key",
		});
		expect(await response.json()).toMatchObject({
			preset: "brave",
			name: "Brave Search",
			baseUrl: "https://api.search.brave.com/res/v1",
		});
	});

	it("refuses a local preset where the installation forbids private addresses", async () => {
		const { app, replace } = routes(false, undefined);

		const response = await app.request(root, {
			method: "PUT",
			headers,
			body: JSON.stringify({ preset: "searxng" }),
		});

		expect(response.status).toBe(400);
		expect(replace).not.toHaveBeenCalled();
	});

	it("will not enable a keyed provider that has no key", async () => {
		const { app, update } = routes(true, stored({ preset: "brave" }));

		const response = await app.request(root, {
			method: "PATCH",
			headers,
			body: JSON.stringify({ enabled: true }),
		});

		expect(response.status).toBe(400);
		expect(update).not.toHaveBeenCalled();

		const withKey = await app.request(root, {
			method: "PATCH",
			headers,
			body: JSON.stringify({ enabled: true, apiKey: "brave-key" }),
		});
		expect(withKey.status).toBe(200);
		expect(await withKey.json()).toMatchObject({ enabled: true, hasApiKey: true });
	});

	it("tests with one real query and records the outcome", async () => {
		const { app, recordTest, search } = routes(true, stored({ preset: "brave", apiKey: "k" }));

		const response = await app.request(`${root}/test`, { method: "POST", headers });

		expect(response.status).toBe(200);
		expect(await response.json()).toMatchObject({ reachable: true, results: 1 });
		expect(search).toHaveBeenCalledOnce();
		expect(recordTest).toHaveBeenCalledWith(
			WORKSPACE_ID,
			new Date("2026-09-14T00:00:00.000Z"),
			undefined,
		);
	});

	it("says what to do when a test has no key to try", async () => {
		const { app, search } = routes(true, stored({ preset: "brave" }));

		const response = await app.request(`${root}/test`, { method: "POST", headers });

		expect(await response.json()).toEqual({
			reachable: false,
			latencyMs: 0,
			error: "Add an API key before testing",
		});
		expect(search).not.toHaveBeenCalled();
	});

	it("removes the provider, and says so when there was none", async () => {
		expect(
			(
				await routes(true, stored({ preset: "searxng" })).app.request(root, {
					method: "DELETE",
					headers,
				})
			).status,
		).toBe(204);
		expect(
			(await routes(true, undefined).app.request(root, { method: "DELETE", headers })).status,
		).toBe(404);
	});
});
