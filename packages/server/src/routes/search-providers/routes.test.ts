import type { SearchProvider } from "@sugabots/contracts";
import {
	SearchProviderApiKeyRequired,
	SearchProviderNotFound,
	UrlNotAllowed,
} from "@sugabots/contracts/errors/providers";
import { Operations } from "@sugabots/core/operations/registry";
import type { Principal } from "@sugabots/core/principal";
import { unimplemented } from "@sugabots/core/testing";
import { userText } from "@sugabots/errors";
import { Effect, Layer } from "effect";
import { describe, expect, it } from "vitest";
import type { MemberResolver } from "../../http/app.test-support.ts";
import {
	createTestApp,
	identifiedBy,
	sessionTokenIn,
	signedInWith,
} from "../../http/app.test-support.ts";

/**
 * The search provider routes over doubles of the search providers operations:
 * which principal each operation is called for, with what, and what each
 * refusal means over HTTP. Who may do what is decided, and tested, in core;
 * the provider's own rules run against Postgres in
 * `search-providers/search-providers.test.ts`.
 */

const WORKSPACE_ID = "0199a3a0-0000-7000-8000-000000000001";
const USER_ID = "0199a3a0-0000-7000-8000-000000000002";
const root = `/workspaces/${WORKSPACE_ID}/search-provider`;
const headers = { ...signedInWith("good-token"), "content-type": "application/json" };

const resolveMember: MemberResolver = async (requestHeaders) =>
	sessionTokenIn(requestHeaders) === "good-token"
		? { id: USER_ID, name: "Sam", email: "sam@example.com", image: null }
		: null;

const brave: SearchProvider = {
	id: "0199a3a0-0000-7000-8000-000000000003",
	workspaceId: WORKSPACE_ID,
	builtIn: "brave",
	name: "Brave Search",
	baseUrl: "https://api.search.brave.com/res/v1",
	enabled: false,
	status: "untested",
	hasApiKey: true,
	lastTestError: null,
	createdAt: "2026-09-14T00:00:00.000Z",
};

/** The app with `operations` as the only operations it has. */
const app = (operations: Partial<Operations.Interface>) =>
	createTestApp(
		Layer.merge(identifiedBy(resolveMember), unimplemented(Operations.Service, operations)),
	);

/** The member a principal is signed in as, as the session authenticator built it. */
const memberOf = (principal: Principal) =>
	principal._tag === "MemberSession" ? principal.member : undefined;

describe("a workspace's search provider", () => {
	it("answers null when the workspace has none", async () => {
		const response = await app({
			"searchProviders.get": () => Effect.succeed({ provider: null }),
		}).request(root, { headers });

		expect(response.status).toBe(200);
		expect(await response.json()).toEqual({ provider: null });
	});

	it("sets a built-in provider as the member asking", async () => {
		let asked: unknown;
		const response = await app({
			"searchProviders.replace": (principal, input) =>
				Effect.sync(() => {
					asked = { ...input, memberId: memberOf(principal) };
					return brave;
				}),
		}).request(root, {
			method: "PUT",
			headers,
			body: JSON.stringify({ builtIn: "brave", apiKey: "brave-key" }),
		});

		expect(response.status).toBe(201);
		expect(asked).toEqual({
			workspace: WORKSPACE_ID,
			builtIn: "brave",
			apiKey: "brave-key",
			memberId: USER_ID,
		});
	});

	it("reports an address the network policy refuses as a bad request", async () => {
		const response = await app({
			"searchProviders.replace": () =>
				Effect.fail(new UrlNotAllowed({ refusal: userText`That address is on a local network.` })),
		}).request(root, { method: "PUT", headers, body: JSON.stringify({ builtIn: "searxng" }) });

		expect(response.status).toBe(400);
	});

	it("reports switching search on without a key as a bad request", async () => {
		const error = new SearchProviderApiKeyRequired();
		const response = await app({
			"searchProviders.update": () => Effect.fail(error),
		}).request(root, { method: "PATCH", headers, body: JSON.stringify({ enabled: true }) });

		expect(response.status).toBe(400);
		expect(await response.json()).toEqual({
			_tag: "BadRequest",
			message: error.userMessage,
			error: {
				_tag: "SearchProviderApiKeyRequired",
				userMessage: error.userMessage,
				isRetryable: false,
			},
		});
	});

	it("says when there was no provider to remove", async () => {
		const response = await app({
			"searchProviders.remove": () => Effect.fail(new SearchProviderNotFound()),
		}).request(root, { method: "DELETE", headers });

		expect(response.status).toBe(404);
	});
});
