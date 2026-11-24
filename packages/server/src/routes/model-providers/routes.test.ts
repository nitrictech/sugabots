import type { ModelProvider } from "@sugabots/contracts";
import { ResourceHidden } from "@sugabots/contracts/errors/proofs";
import {
	DiscoveryUnreachable,
	ModelProviderNameConflict,
	ProviderActivationRequiresCredential,
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
 * The model provider routes over doubles of the model providers operations:
 * which principal each operation is called for, with what, and what each
 * refusal means over HTTP. Who may do what is decided, and tested, in core;
 * the providers' own rules run against Postgres in
 * `model-providers/model-providers.test.ts`.
 */

const WORKSPACE_ID = "0199a3a0-0000-7000-8000-000000000001";
const USER_ID = "0199a3a0-0000-7000-8000-000000000002";
const PROVIDER_ID = "0199a3a0-0000-7000-8000-000000000003";
const root = `/workspaces/${WORKSPACE_ID}/model-providers`;
const headers = { ...signedInWith("good-token"), "content-type": "application/json" };

const resolveMember: MemberResolver = async (requestHeaders) =>
	sessionTokenIn(requestHeaders) === "good-token"
		? { id: USER_ID, name: "Sam", email: "sam@example.com", image: null }
		: null;

const groq: ModelProvider = {
	id: PROVIDER_ID,
	workspaceId: WORKSPACE_ID,
	builtIn: "groq",
	name: "Groq",
	baseUrl: "https://api.groq.com/openai/v1",
	apiFormat: "openai",
	active: false,
	status: "untested",
	hasApiKey: true,
	signedIn: false,
	customHeaders: [],
	lastTestError: null,
	connectedBy: null,
	signedInAs: null,
	createdAt: "2026-09-09T00:00:00.000Z",
	models: [],
};

/** The app with `operations` as the only operations it has. */
const app = (operations: Partial<Operations.Interface>) =>
	createTestApp(
		Layer.merge(identifiedBy(resolveMember), unimplemented(Operations.Service, operations)),
	);

/** The member a principal is signed in as, as the session authenticator built it. */
const memberOf = (principal: Principal) =>
	principal._tag === "MemberSession" ? principal.member : undefined;

describe("model provider routes", () => {
	it("adds a built-in provider as the member asking", async () => {
		let asked: unknown;
		const response = await app({
			"modelProviders.create": (principal, input) =>
				Effect.sync(() => {
					asked = { ...input, memberId: memberOf(principal) };
					return groq;
				}),
		}).request(root, {
			method: "POST",
			headers,
			body: JSON.stringify({ builtIn: "groq", apiKey: "gsk-test" }),
		});

		expect(response.status).toBe(201);
		expect(asked).toEqual({
			workspace: WORKSPACE_ID,
			provider: { builtIn: "groq", apiKey: "gsk-test" },
			memberId: USER_ID,
		});
	});

	it("reports an address the network policy refuses as a bad request, in its own words", async () => {
		const refusal =
			"That address is on a local or private network, which this server doesn't connect to, so other services on the network stay out of reach. Use a public address, or ask whoever runs Sugabots to allow local network addresses.";
		const response = await app({
			"modelProviders.create": () =>
				Effect.fail(new UrlNotAllowed({ refusal: userText`${refusal}` })),
		}).request(root, {
			method: "POST",
			headers,
			body: JSON.stringify({ builtIn: "lmstudio" }),
		});

		expect(response.status).toBe(400);
		expect(await response.json()).toEqual({
			_tag: "BadRequest",
			message: refusal,
			error: { _tag: "UrlNotAllowed", userMessage: refusal, isRetryable: false },
		});
	});

	it("reports a name already used in the workspace as a conflict", async () => {
		const response = await app({
			"modelProviders.create": () => Effect.fail(new ModelProviderNameConflict()),
		}).request(root, {
			method: "POST",
			headers,
			body: JSON.stringify({
				name: "Gateway",
				baseUrl: "https://models.example/v1",
				apiFormat: "openai",
			}),
		});

		expect(response.status).toBe(409);
	});

	it("passes a change through, and reports activation without a key as a bad request", async () => {
		let asked: unknown;
		const response = await app({
			"modelProviders.update": (_principal, input) => {
				asked = input;
				return Effect.fail(new ProviderActivationRequiresCredential({ missing: "api-key" }));
			},
		}).request(`${root}/${PROVIDER_ID}`, {
			method: "PATCH",
			headers,
			body: JSON.stringify({ active: true }),
		});

		expect(response.status).toBe(400);
		expect(asked).toEqual({
			workspace: WORKSPACE_ID,
			providerId: PROVIDER_ID,
			changes: { active: true },
		});
	});

	it("answers a workspace hidden from the caller as not found", async () => {
		const response = await app({
			"modelProviders.list": () => Effect.fail(new ResourceHidden({ resource: "workspace" })),
		}).request(root, { headers });

		expect(response.status).toBe(404);
	});

	it("keeps what a provider or the network said about a failed refresh out of the response", async () => {
		const response = await app({
			"modelProviders.discoverModels": () =>
				Effect.fail(
					new DiscoveryUnreachable({ cause: new Error("getaddrinfo ENOTFOUND 10.0.0.7") }),
				),
		}).request(`${root}/${PROVIDER_ID}/discover-models`, { method: "POST", headers });

		expect(response.status).toBe(400);
		const body = await response.json();
		expect(body).toMatchObject({
			_tag: "BadRequest",
			message:
				"We can't reach the provider. Check its address, and that the server is running if it's your own. Then try again.",
			error: { _tag: "DiscoveryUnreachable", isRetryable: true },
		});
		expect(JSON.stringify(body)).not.toContain("ENOTFOUND");
	});
});
