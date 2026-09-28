import type { ModelProvider } from "@sugabots/contracts";
import { ModelProviderRepository } from "@sugabots/core/providers/model-providers/model-provider-repository";
import { ModelProviderSetup } from "@sugabots/core/providers/model-providers/model-provider-setup";
import { ModelDiscoveryFailed } from "@sugabots/core/providers/model-providers/remote";
import { EgressRefused } from "@sugabots/core/providers/network/egress";
import { UrlNotAllowed } from "@sugabots/core/providers/tested-configuration";
import { unimplemented } from "@sugabots/core/testing";
import { UserMessage } from "@sugabots/core/user-message";
import { ResourceHidden } from "@sugabots/core/workspaces/access";
import { CurrentActor } from "@sugabots/core/workspaces/current-actor";
import { Effect } from "effect";
import { describe, expect, it, vi } from "vitest";
import type { UserResolver } from "../../http/app.test-support.ts";
import { createTestApp } from "../../http/app.test-support.ts";

/**
 * The model provider routes over doubles of `ModelProviderSetup`: what each
 * request asks of it and what each refusal means over HTTP. The setup's own
 * rules run against Postgres in `model-providers/model-providers.test.ts`.
 */

const WORKSPACE_ID = "0199a3a0-0000-7000-8000-000000000001";
const USER_ID = "0199a3a0-0000-7000-8000-000000000002";
const PROVIDER_ID = "0199a3a0-0000-7000-8000-000000000003";
const root = `/workspaces/${WORKSPACE_ID}/model-providers`;
const headers = { authorization: "Bearer good-token", "content-type": "application/json" };

const resolveUser: UserResolver = async (requestHeaders) =>
	requestHeaders.get("authorization") === "Bearer good-token"
		? { id: USER_ID, name: "Sam", email: "sam@example.com", image: null }
		: null;

const groq: ModelProvider = {
	id: PROVIDER_ID,
	workspaceId: WORKSPACE_ID,
	preset: "groq",
	name: "Groq",
	baseUrl: "https://api.groq.com/openai/v1",
	apiFormat: "openai",
	active: false,
	status: "untested",
	hasApiKey: true,
	apiKeyHint: "",
	customHeaders: [],
	modelCount: 0,
	enabledModelCount: 0,
	lastTestedAt: null,
	lastTestError: null,
	models: [],
};

const app = (providers: Partial<ModelProviderSetup.Interface>) =>
	createTestApp({
		resolveUser,
		services: unimplemented(ModelProviderSetup.Service, providers),
	});

describe("model provider routes", () => {
	it("adds a provider from the catalog as the person asking", async () => {
		let askedAs: string | undefined;
		const create = vi.fn<ModelProviderSetup.Interface["create"]>(() =>
			Effect.map(CurrentActor.Service, ({ userId }) => {
				askedAs = userId;
				return groq;
			}),
		);

		const response = await app({ create }).request(root, {
			method: "POST",
			headers,
			body: JSON.stringify({ preset: "groq", apiKey: "gsk-test" }),
		});

		expect(response.status).toBe(201);
		expect(create).toHaveBeenCalledWith({
			workspace: WORKSPACE_ID,
			provider: { preset: "groq", apiKey: "gsk-test" },
		});
		expect(askedAs).toBe(USER_ID);
	});

	it("reports an address the network policy refuses as a bad request, in its own words", async () => {
		const response = await app({
			create: () =>
				Effect.fail(
					new UrlNotAllowed({ refusal: new EgressRefused({ reason: "privateNetwork" }) }),
				),
		}).request(root, {
			method: "POST",
			headers,
			body: JSON.stringify({ preset: "lmstudio" }),
		});

		expect(response.status).toBe(400);
		expect(await response.json()).toEqual({
			_tag: "BadRequest",
			message: "That address is not allowed: Address is on a private or reserved network",
		});
	});

	it("reports a name already used in the workspace as a conflict", async () => {
		const response = await app({
			create: () => Effect.fail(new ModelProviderRepository.ModelProviderNameConflict()),
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
		const update = vi.fn<ModelProviderSetup.Interface["update"]>(() =>
			Effect.fail(new ModelProviderSetup.ProviderActivationRequiresApiKey()),
		);

		const response = await app({ update }).request(`${root}/${PROVIDER_ID}`, {
			method: "PATCH",
			headers,
			body: JSON.stringify({ active: true }),
		});

		expect(response.status).toBe(400);
		expect(update).toHaveBeenCalledWith({
			workspace: WORKSPACE_ID,
			providerId: PROVIDER_ID,
			changes: { active: true },
		});
	});

	it("answers a workspace hidden from the caller as not found", async () => {
		const response = await app({
			list: () => Effect.fail(new ResourceHidden({ resource: "workspace" })),
		}).request(root, { headers });

		expect(response.status).toBe(404);
	});

	it("keeps what a provider or the network said about a failed refresh out of the response", async () => {
		const response = await app({
			fetchModels: () =>
				Effect.fail(
					new ModelDiscoveryFailed({
						message: "The provider could not be reached: getaddrinfo ENOTFOUND 10.0.0.7",
						userMessage: UserMessage.of`Connection failed`,
					}),
				),
		}).request(`${root}/${PROVIDER_ID}/fetch-models`, { method: "POST", headers });

		expect(response.status).toBe(400);
		expect(await response.json()).toEqual({ _tag: "BadRequest", message: "Connection failed" });
	});
});
