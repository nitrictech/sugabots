import type { SearchProvider } from "@sugabots/contracts";
import { EgressRefused } from "@sugabots/core/providers/network/egress";
import { SearchProviderRepository } from "@sugabots/core/providers/search-providers/search-provider-repository";
import { SearchProviderSetup } from "@sugabots/core/providers/search-providers/search-provider-setup";
import { UrlNotAllowed } from "@sugabots/core/providers/tested-configuration";
import { unimplemented } from "@sugabots/core/testing";
import { testAuthorization } from "@sugabots/core/workspaces/testing";
import { Effect } from "effect";
import { describe, expect, it, vi } from "vitest";
import type { UserResolver } from "../../http/app.test-support.ts";
import { createTestApp } from "../../http/app.test-support.ts";

/**
 * The search provider routes over doubles of `SearchProviderSetup`: what each
 * request asks of it and what each refusal means over HTTP. The setup's own
 * rules run against Postgres in `search-providers/search-provider-setup.test.ts`.
 */

const WORKSPACE_ID = "0199a3a0-0000-7000-8000-000000000001";
const USER_ID = "0199a3a0-0000-7000-8000-000000000002";
const root = `/workspaces/${WORKSPACE_ID}/search-provider`;
const headers = { authorization: "Bearer good-token", "content-type": "application/json" };

const resolveUser: UserResolver = async (requestHeaders) =>
	requestHeaders.get("authorization") === "Bearer good-token"
		? { id: USER_ID, name: "Sam", email: "sam@example.com", image: null }
		: null;

const authorization = testAuthorization({ id: WORKSPACE_ID, roles: { [USER_ID]: "admin" } });

const brave: SearchProvider = {
	id: "0199a3a0-0000-7000-8000-000000000003",
	workspaceId: WORKSPACE_ID,
	preset: "brave",
	name: "Brave Search",
	baseUrl: "https://api.search.brave.com/res/v1",
	enabled: false,
	status: "untested",
	hasApiKey: true,
	apiKeyHint: "",
	lastTestedAt: null,
	lastTestError: null,
	createdAt: "2026-09-14T00:00:00.000Z",
};

const app = (search: Partial<SearchProviderSetup.Interface>) =>
	createTestApp({
		resolveUser,
		authorization,
		services: unimplemented(SearchProviderSetup.Service, search),
	});

describe("a workspace's search provider", () => {
	it("answers null when the workspace has none", async () => {
		const response = await app({ get: () => Effect.undefined }).request(root, { headers });

		expect(response.status).toBe(200);
		expect(await response.json()).toEqual({ provider: null });
	});

	it("sets a provider from the catalog as the person asking", async () => {
		const replace = vi.fn<SearchProviderSetup.Interface["replace"]>(() => Effect.succeed(brave));

		const response = await app({ replace }).request(root, {
			method: "PUT",
			headers,
			body: JSON.stringify({ preset: "brave", apiKey: "brave-key" }),
		});

		expect(response.status).toBe(201);
		expect(replace).toHaveBeenCalledWith({
			workspaceId: WORKSPACE_ID,
			createdById: USER_ID,
			provider: { preset: "brave", apiKey: "brave-key" },
		});
	});

	it("reports an address the network policy refuses as a bad request", async () => {
		const response = await app({
			replace: () =>
				Effect.fail(
					new UrlNotAllowed({ refusal: new EgressRefused({ reason: "privateNetwork" }) }),
				),
		}).request(root, { method: "PUT", headers, body: JSON.stringify({ preset: "searxng" }) });

		expect(response.status).toBe(400);
	});

	it("reports switching search on without a key as a bad request", async () => {
		const response = await app({
			update: () => Effect.fail(new SearchProviderRepository.SearchProviderApiKeyRequired()),
		}).request(root, { method: "PATCH", headers, body: JSON.stringify({ enabled: true }) });

		expect(response.status).toBe(400);
		expect(await response.json()).toEqual({
			_tag: "BadRequest",
			message: "Add an API key before enabling search",
		});
	});

	it("says when there was no provider to remove", async () => {
		const response = await app({
			remove: () => Effect.fail(new SearchProviderSetup.SearchProviderNotFound()),
		}).request(root, { method: "DELETE", headers });

		expect(response.status).toBe(404);
	});
});
