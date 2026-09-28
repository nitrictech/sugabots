import {
	type ModelProvider,
	type ModelProviderUpdate,
	type NewCustomProvider,
	type NewModelProvider,
	providerPreset,
} from "@sugabots/contracts";
import { ModelRequestFailed } from "@sugabots/core/conversations/turns/model";
import {
	ModelProviderNameConflict,
	type ModelProviderStore,
} from "@sugabots/core/providers/model-providers/store";
import { createEgressUrlValidator } from "@sugabots/core/providers/network/egress";
import { testAuthorization } from "@sugabots/core/workspaces/testing";
import { Effect } from "effect";
import { describe, expect, it, vi } from "vitest";
import type { UserResolver } from "../../http/app.test-support.ts";
import { createTestApp, type TestApp } from "../../http/app.test-support.ts";

const WORKSPACE_ID = "0199a3a0-0000-7000-8000-000000000001";
const USER_ID = "0199a3a0-0000-7000-8000-000000000002";
const PROVIDER_ID = "0199a3a0-0000-7000-8000-000000000003";

const resolveUser: UserResolver = async (headers) =>
	headers.get("authorization") === "Bearer good-token"
		? { id: USER_ID, name: "Sam", email: "sam@example.com", image: null }
		: null;

const authorization = testAuthorization({
	id: WORKSPACE_ID,
	roles: { [USER_ID]: "admin" },
});

/** A store method no case in this file is expected to reach. */
const unused = () => Effect.die(new Error("This case does not use this store method"));

function provider(input: NewCustomProvider): ModelProvider {
	return {
		id: PROVIDER_ID,
		workspaceId: WORKSPACE_ID,
		preset: null,
		name: input.name,
		baseUrl: input.baseUrl,
		apiFormat: input.apiFormat,
		active: false,
		status: "untested",
		hasApiKey: input.apiKey !== undefined,
		apiKeyHint: input.apiKey === undefined ? null : "********",
		customHeaders: [],
		modelCount: 0,
		enabledModelCount: 0,
		lastTestedAt: null,
		lastTestError: null,
		models: [],
	};
}

/** One spy, so a test that asserts on the calls sees all of them. */
const unreachableProvider = vi.fn(async () => new Response(null, { status: 503 }));

function routes(
	allowPrivateNetwork: boolean,
	preset: ModelProvider["preset"] = null,
	overrides: Partial<ModelProviderStore> = {},
) {
	let stored: ModelProvider | undefined = {
		...provider({
			name: "Existing provider",
			baseUrl: "https://models.example/v1",
			apiFormat: "openai",
			customHeaders: [],
		}),
		preset,
	};
	const create = vi.fn(
		(
			_workspaceId: string,
			_userId: string,
			input: NewModelProvider,
		): ReturnType<ModelProviderStore["create"]> =>
			Effect.sync(() => {
				stored =
					"preset" in input
						? {
								...provider({
									name: providerPreset(input.preset).name,
									baseUrl: input.baseUrl ?? providerPreset(input.preset).baseUrl,
									apiFormat: providerPreset(input.preset).apiFormat,
									apiKey: input.apiKey,
									customHeaders: [],
								}),
								preset: input.preset,
							}
						: provider(input);
				return stored;
			}),
	);
	const update = vi.fn((_workspaceId: string, _providerId: string, input: ModelProviderUpdate) =>
		Effect.sync(() => {
			if (stored && input.baseUrl) stored = { ...stored, baseUrl: input.baseUrl };
			return stored;
		}),
	);
	const store: ModelProviderStore = {
		list: unused,
		get: () => Effect.sync(() => stored),
		create,
		update,
		remove: unused,
		connection: unused,
		resolve: unused,
		recordTest: unused,
		addModels: unused,
		syncDiscovered: unused,
		setModelEnabled: unused,
		updateModel: unused,
		removeModel: unused,
		listEnabled: unused,
		isEnabled: unused,
		...overrides,
	};
	const app = createTestApp({
		resolveUser,
		authorization,
		stores: { modelProviders: store },
		httpClients: { for: () => unreachableProvider },
		validateProviderUrl: createEgressUrlValidator({ allowPrivateNetwork }),
		model: {
			stream: () =>
				Effect.fail(
					new ModelRequestFailed({
						message: "This case does not ask a model",
						reason: "unavailable",
					}),
				),
		},
	});
	return {
		create,
		update,
		app,
	};
}

function createLocalProvider(app: TestApp, baseUrl = "http://localhost:11434/v1") {
	return app.request(`/workspaces/${WORKSPACE_ID}/model-providers`, {
		method: "POST",
		headers: { authorization: "Bearer good-token", "content-type": "application/json" },
		body: JSON.stringify({
			name: "Local gateway",
			baseUrl,
			apiFormat: "openai",
		}),
	});
}

describe("creating a model provider", () => {
	it("keeps a saved credential when model discovery hits a database fault", async () => {
		const { app } = routes(true, null, {
			// Discovery reads the connection back and records what it found. A
			// fault there is a defect, and it must not reach the caller: the
			// provider row and its key are already committed.
			connection: () => Effect.die(new Error("database unavailable")),
		});

		const response = await app.request(`/workspaces/${WORKSPACE_ID}/model-providers`, {
			method: "POST",
			headers: { authorization: "Bearer good-token", "content-type": "application/json" },
			body: JSON.stringify({
				name: "Keyed gateway",
				baseUrl: "https://models.example/v1",
				apiFormat: "openai",
				apiKey: "secret",
			}),
		});

		expect(response.status).toBe(201);
	});

	it("adds a provider from the catalog with only its key, the preset supplying the rest", async () => {
		const { app, create } = routes(true);

		const response = await app.request(`/workspaces/${WORKSPACE_ID}/model-providers`, {
			method: "POST",
			headers: { authorization: "Bearer good-token", "content-type": "application/json" },
			body: JSON.stringify({ preset: "groq", apiKey: "gsk-test" }),
		});

		expect(response.status).toBe(201);
		expect(create).toHaveBeenCalledWith(WORKSPACE_ID, expect.any(String), {
			preset: "groq",
			apiKey: "gsk-test",
		});
		expect(await response.json()).toMatchObject({
			preset: "groq",
			name: "Groq",
			baseUrl: "https://api.groq.com/openai/v1",
			apiFormat: "openai",
		});
	});

	it("refuses a local preset where the installation forbids private addresses", async () => {
		// Its stock address is on this machine, so saving it would only produce a
		// provider whose every test connection fails for a reason the form never
		// showed.
		const { app, create } = routes(false);

		const response = await app.request(`/workspaces/${WORKSPACE_ID}/model-providers`, {
			method: "POST",
			headers: { authorization: "Bearer good-token", "content-type": "application/json" },
			body: JSON.stringify({ preset: "lmstudio" }),
		});

		expect(response.status).toBe(400);
		expect(create).not.toHaveBeenCalled();
	});

	it("reports a name already used in the workspace as a conflict", async () => {
		const { app, create } = routes(true);
		create.mockReturnValueOnce(Effect.fail(new ModelProviderNameConflict()));

		const response = await createLocalProvider(app);

		expect(response.status).toBe(409);
	});
});

describe("model provider network policy", () => {
	it("rejects an HTTP provider when private networking is disabled", async () => {
		const { app, create } = routes(false);

		expect((await createLocalProvider(app)).status).toBe(400);
		expect(create).not.toHaveBeenCalled();
	});

	it("rejects a private HTTPS provider when private networking is disabled", async () => {
		const { app, create } = routes(false);

		expect((await createLocalProvider(app, "https://127.0.0.1:11434/v1")).status).toBe(400);
		expect(create).not.toHaveBeenCalled();
	});

	it("accepts an HTTP provider when private networking is explicitly enabled", async () => {
		const { app, create } = routes(true);

		expect((await createLocalProvider(app)).status).toBe(201);
		expect(create).toHaveBeenCalledOnce();
	});

	it("rejects changing a provider to a private HTTPS URL when disabled", async () => {
		const { app, update } = routes(false);
		const response = await app.request(
			`/workspaces/${WORKSPACE_ID}/model-providers/${PROVIDER_ID}`,
			{
				method: "PATCH",
				headers: { authorization: "Bearer good-token", "content-type": "application/json" },
				body: JSON.stringify({ baseUrl: "https://127.0.0.1:11434/v1" }),
			},
		);

		expect(response.status).toBe(400);
		expect(update).not.toHaveBeenCalled();
	});

	it("holds the seeded Ollama provider to the same policy as every other provider", async () => {
		// Its address is editable, so an exemption by preset would let a workspace
		// point "Ollama" at anything on the installation's network.
		const { app, update } = routes(false, "ollama");
		const response = await app.request(
			`/workspaces/${WORKSPACE_ID}/model-providers/${PROVIDER_ID}`,
			{
				method: "PATCH",
				headers: { authorization: "Bearer good-token", "content-type": "application/json" },
				body: JSON.stringify({ baseUrl: "http://192.168.1.10:11434/v1" }),
			},
		);

		expect(response.status).toBe(400);
		expect(update).not.toHaveBeenCalled();
	});
});

describe("keyless model providers", () => {
	it("accepts a keyless Ollama activation request for connection testing", async () => {
		const { app } = routes(true, "ollama", {
			connection: () =>
				Effect.succeed({
					providerId: PROVIDER_ID,
					preset: "ollama",
					baseUrl: "http://localhost:11434/v1",
					apiFormat: "openai",
					headers: {},
					configurationUpdatedAt: new Date("2026-09-01T00:00:00Z"),
				}),
			recordTest: () => Effect.void,
		});
		const response = await app.request(
			`/workspaces/${WORKSPACE_ID}/model-providers/${PROVIDER_ID}`,
			{
				method: "PATCH",
				headers: { authorization: "Bearer good-token", "content-type": "application/json" },
				body: JSON.stringify({ active: true }),
			},
		);

		expect(response.status).toBe(200);
	});

	it("removes a stored API key when an update clears it", async () => {
		const { app, update } = routes(true, "ollama");
		const response = await app.request(
			`/workspaces/${WORKSPACE_ID}/model-providers/${PROVIDER_ID}`,
			{
				method: "PATCH",
				headers: { authorization: "Bearer good-token", "content-type": "application/json" },
				body: JSON.stringify({ apiKey: null }),
			},
		);

		expect(response.status).toBe(200);
		expect(update).toHaveBeenCalledWith(WORKSPACE_ID, PROVIDER_ID, { apiKey: null });
	});

	it("still requires an API key for custom providers", async () => {
		const { app, update } = routes(true);
		const response = await app.request(
			`/workspaces/${WORKSPACE_ID}/model-providers/${PROVIDER_ID}`,
			{
				method: "PATCH",
				headers: { authorization: "Bearer good-token", "content-type": "application/json" },
				body: JSON.stringify({ active: true }),
			},
		);

		expect(response.status).toBe(400);
		expect(update).not.toHaveBeenCalled();
	});
});
