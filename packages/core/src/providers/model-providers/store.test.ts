import { Effect } from "effect";
import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { TurnModel } from "../../conversations/turns/model.ts";
import { user, workspace } from "../../database/schema.ts";
import { closeDatabase, onDatabase, onPostgres } from "../../database/testing.ts";
import { aesCredentialCipher } from "./credentials.ts";
import { modelProviderOperations } from "./operations.ts";
import { modelProviderStore } from "./store.ts";

/**
 * Recording what a provider offers, against real SQL.
 *
 * The upsert is the part a fake cannot check: whether a second discovery
 * updates a fetched row, leaves a manual one alone, and counts each exactly
 * once. Needs a migrated database and skips without one; CI always has one.
 */
describe.skipIf(!process.env.DATABASE_URL)("model providers, against Postgres", () => {
	const providers = modelProviderStore(aesCredentialCipher(Buffer.alloc(32, 7).toString("base64")));
	const store = onPostgres(providers);
	const operationsWithResponse = (
		respond: () => Response | Promise<Response>,
		model: TurnModel = {
			stream: () => {
				throw new Error("No models are enabled");
			},
		},
	) =>
		onPostgres(
			modelProviderOperations({
				providers,
				httpClients: { for: () => async () => respond() },
				validateProviderUrl: async () => {},
				model,
			}),
		);

	let workspaceId: string;
	let userId: string;
	let providerId: string;

	afterAll(async () => {
		await closeDatabase();
	});

	beforeEach(async () => {
		const stamp = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
		const [made] = await onDatabase((db) =>
			db
				.insert(workspace)
				.values({ name: `Test ${stamp}`, slug: `test-${stamp}` })
				.returning(),
		);
		const [person] = await onDatabase((db) =>
			db
				.insert(user)
				.values({ name: "Ada", email: `ada-${stamp}@example.com` })
				.returning(),
		);
		if (!made || !person) throw new Error("could not create the test workspace");
		workspaceId = made.id;
		userId = person.id;
		const provider = await store.create(workspaceId, userId, {
			name: `Gateway ${stamp}`,
			baseUrl: "https://models.example/v1",
			apiFormat: "openai",
			apiKey: "secret",
			customHeaders: [],
		});
		providerId = provider.id;
	});

	it.each([
		{ httpStatus: 200, active: true, status: "connected" },
		{ httpStatus: 401, active: false, status: "error" },
	])(
		"validates a new provider before enabling it: $httpStatus",
		async ({ httpStatus, active, status }) => {
			const operations = operationsWithResponse(() =>
				Response.json({ data: [] }, { status: httpStatus }),
			);
			const created = await operations.create(workspaceId, userId, {
				name: "New gateway",
				baseUrl: "https://new.example/v1",
				apiFormat: "openai",
				apiKey: "new-key",
				customHeaders: [],
			});

			expect(created).toMatchObject({ active, hasApiKey: true, status });
			expect(await store.get(workspaceId, created.id)).toMatchObject({ active, status });
		},
	);

	it.each(["first", "replacement"])(
		"keeps a rejected %s API key saved but disabled",
		async (key) => {
			const openai = (await store.list(workspaceId)).find(({ preset }) => preset === "openai");
			if (!openai) throw new Error("fixture");
			expect(openai).toMatchObject({ active: false, hasApiKey: false });
			if (key === "replacement") {
				await store.update(workspaceId, openai.id, { apiKey: "old-key" });
				await store.update(workspaceId, openai.id, { active: true });
			}
			let activeDuringCheck: boolean | undefined;
			const operations = operationsWithResponse(async () => {
				activeDuringCheck = (await store.get(workspaceId, openai.id))?.active;
				return new Response(null, { status: 401 });
			});

			const saved = await operations.update(workspaceId, openai.id, { apiKey: "secret" });

			expect(activeDuringCheck).toBe(false);
			expect(saved).toMatchObject({ active: false, hasApiKey: true, status: "error" });
			expect(await store.get(workspaceId, openai.id)).toMatchObject({
				active: false,
				hasApiKey: true,
			});
		},
	);

	it.each([
		{ requestedActive: undefined, active: true },
		{ requestedActive: false, active: false },
	])(
		"applies activation preference $requestedActive after a successful key check",
		async ({ requestedActive, active }) => {
			const operations = operationsWithResponse(() => Response.json({ data: [] }));
			const saved = await operations.update(workspaceId, providerId, {
				apiKey: "replacement",
				active: requestedActive,
			});

			expect(saved).toMatchObject({ active, status: "connected" });
			expect(await store.get(workspaceId, providerId)).toMatchObject({ active });
		},
	);

	it.each([{ baseUrl: "https://other.example/v1" }, { apiKey: null }])(
		"does not enable a disabled provider for an unrelated update: %j",
		async (input) => {
			await store.update(workspaceId, providerId, { active: false });
			await store.update(workspaceId, providerId, input);

			expect(await store.get(workspaceId, providerId)).toMatchObject({ active: false });
		},
	);

	it.each([
		{ httpStatus: 200, reachable: true, active: true, connectionStatus: "connected" },
		{ httpStatus: 503, reachable: false, active: false, connectionStatus: "error" },
	])(
		"enables a local provider only after a successful connection test: $httpStatus",
		async ({ httpStatus, reachable, active, connectionStatus }) => {
			const ollama = (await store.list(workspaceId)).find(({ preset }) => preset === "ollama");
			if (!ollama) throw new Error("fixture");
			expect(ollama).toMatchObject({ active: false, hasApiKey: false });

			const operations = operationsWithResponse(() =>
				Response.json({ models: [] }, { status: httpStatus }),
			);
			const result = await operations.test(workspaceId, ollama.id);

			expect(result.reachable).toBe(reachable);
			expect(await store.get(workspaceId, ollama.id)).toMatchObject({
				active,
				status: connectionStatus,
			});
		},
	);

	it("re-enables a configured provider when testing its connection", async () => {
		await store.update(workspaceId, providerId, { active: false });
		const operations = operationsWithResponse(() => Response.json({ data: [] }));

		expect(await operations.test(workspaceId, providerId)).toMatchObject({
			reachable: true,
		});
		expect(await store.get(workspaceId, providerId)).toMatchObject({ active: true });
	});

	it("disables an enabled provider when its key is rejected during a connection test", async () => {
		await store.update(workspaceId, providerId, { active: true });
		const operations = operationsWithResponse(() => new Response(null, { status: 401 }));

		expect(await operations.test(workspaceId, providerId)).toMatchObject({ reachable: false });
		expect(await store.get(workspaceId, providerId)).toMatchObject({
			active: false,
			status: "error",
		});
	});

	it("does not allow manual activation to bypass a rejected key", async () => {
		const operations = operationsWithResponse(() => new Response(null, { status: 401 }));

		const saved = await operations.update(workspaceId, providerId, { active: true });

		expect(saved).toMatchObject({ active: false, status: "error" });
	});

	it("disables a provider whose model rejects a probe after its model listing succeeds", async () => {
		await store.addModels(workspaceId, providerId, [
			{
				modelId: "test-model",
				displayName: null,
				capabilities: [],
				contextLength: null,
				source: "manual",
			},
		]);
		const [configured] = (await store.get(workspaceId, providerId))?.models ?? [];
		if (!configured) throw new Error("fixture");
		await store.setModelEnabled(workspaceId, providerId, [configured.id], true);
		const operations = operationsWithResponse(() => Response.json({ data: [] }), {
			stream: () => Effect.fail(new Error("API key rejected")),
		});

		expect(await operations.test(workspaceId, providerId)).toMatchObject({ reachable: false });
		expect(await store.get(workspaceId, providerId)).toMatchObject({
			active: false,
			status: "error",
			lastTestError: "test-model: API key rejected",
		});
	});

	it("does not let an in-flight successful test undo a manual deactivation", async () => {
		vi.useFakeTimers({ toFake: ["Date"] });
		try {
			vi.setSystemTime(new Date("2030-01-01T00:00:00Z"));
			await store.update(workspaceId, providerId, { active: true });
			const operations = operationsWithResponse(async () => {
				vi.setSystemTime(new Date("2030-01-01T00:00:01Z"));
				await store.update(workspaceId, providerId, { active: false });
				return Response.json({ data: [] });
			});

			await operations.test(workspaceId, providerId);

			expect(await store.get(workspaceId, providerId)).toMatchObject({ active: false });
		} finally {
			vi.useRealTimers();
		}
	});

	it("does not reactivate a manually disabled provider when refreshing models", async () => {
		await store.update(workspaceId, providerId, { active: false });
		const operations = operationsWithResponse(() => Response.json({ data: [] }));

		await operations.fetchModels(workspaceId, providerId);

		expect(await store.get(workspaceId, providerId)).toMatchObject({
			active: false,
			status: "connected",
		});
	});

	it("does not enable a provider that still needs an API key when testing", async () => {
		const openai = (await store.list(workspaceId)).find(({ preset }) => preset === "openai");
		if (!openai) throw new Error("fixture");
		const operations = operationsWithResponse(() => Response.json({ data: [] }));

		expect(await operations.test(workspaceId, openai.id)).toMatchObject({
			reachable: false,
		});
		expect(await store.get(workspaceId, openai.id)).toMatchObject({ active: false });
	});

	it("adds what is new, updates what changed, and counts each once", async () => {
		const first = await store.syncDiscovered(workspaceId, providerId, [
			{ modelId: "alpha", displayName: "Alpha", capabilities: [], contextLength: null },
			{ modelId: "beta", displayName: null, capabilities: ["tools"], contextLength: 8_000 },
		]);
		expect(first).toEqual({ added: 2, updated: 0 });

		const second = await store.syncDiscovered(workspaceId, providerId, [
			{
				modelId: "alpha",
				displayName: "Alpha",
				capabilities: ["tools", "vision"],
				contextLength: 128_000,
			},
			{ modelId: "beta", displayName: null, capabilities: ["tools"], contextLength: 8_000 },
			{ modelId: "gamma", displayName: null, capabilities: [], contextLength: null },
		]);
		expect(second).toEqual({ added: 1, updated: 1 });

		const provider = await store.get(workspaceId, providerId);
		expect(
			provider?.models.map(({ modelId, capabilities, contextLength, source }) => ({
				modelId,
				capabilities,
				contextLength,
				source,
			})),
		).toEqual([
			{
				modelId: "alpha",
				capabilities: ["tools", "vision"],
				contextLength: 128_000,
				source: "fetched",
			},
			{ modelId: "beta", capabilities: ["tools"], contextLength: 8_000, source: "fetched" },
			{ modelId: "gamma", capabilities: [], contextLength: null, source: "fetched" },
		]);
	});

	it("switches a capability off within what the provider reports, and a refresh keeps the choice", async () => {
		await store.syncDiscovered(workspaceId, providerId, [
			{
				modelId: "alpha",
				displayName: "Alpha",
				capabilities: ["tools", "vision"],
				contextLength: null,
			},
		]);
		const [alpha] = (await store.get(workspaceId, providerId))?.models ?? [];
		if (!alpha) throw new Error("fixture");

		expect(
			await store.updateModel(workspaceId, providerId, alpha.id, {
				disabledCapabilities: ["vision"],
			}),
		).toBe(1);
		const synced = await store.syncDiscovered(workspaceId, providerId, [
			{
				modelId: "alpha",
				displayName: "Alpha",
				capabilities: ["tools", "vision", "audio"],
				contextLength: 32_000,
			},
		]);

		expect(synced).toEqual({ added: 0, updated: 1 });
		expect((await store.get(workspaceId, providerId))?.models).toMatchObject([
			{
				modelId: "alpha",
				capabilities: ["tools", "vision", "audio"],
				disabledCapabilities: ["vision"],
				contextLength: 32_000,
			},
		]);
	});

	it("leaves a model somebody added by hand as they wrote it", async () => {
		await store.addModels(workspaceId, providerId, [
			{
				modelId: "hand-made",
				displayName: "Mine",
				capabilities: ["tools"],
				contextLength: 4_000,
				source: "manual",
			},
		]);

		const synced = await store.syncDiscovered(workspaceId, providerId, [
			{ modelId: "hand-made", displayName: null, capabilities: [], contextLength: null },
		]);
		expect(synced).toEqual({ added: 0, updated: 0 });

		const provider = await store.get(workspaceId, providerId);
		expect(provider?.models).toMatchObject([
			{
				modelId: "hand-made",
				displayName: "Mine",
				capabilities: ["tools"],
				contextLength: 4_000,
				source: "manual",
			},
		]);
	});

	it("leaves a model another provider in the workspace already lists to it", async () => {
		const other = await store.create(workspaceId, userId, {
			name: `Other ${providerId}`,
			baseUrl: "https://other.example/v1",
			apiFormat: "openai",
			apiKey: "secret",
			customHeaders: [],
		});
		await store.syncDiscovered(workspaceId, other.id, [
			{ modelId: "shared-id", displayName: null, capabilities: [], contextLength: null },
		]);

		const synced = await store.syncDiscovered(workspaceId, providerId, [
			{ modelId: "shared-id", displayName: null, capabilities: [], contextLength: null },
			{ modelId: "own-id", displayName: null, capabilities: [], contextLength: null },
		]);
		expect(synced).toEqual({ added: 1, updated: 0 });
		expect(
			(await store.get(workspaceId, providerId))?.models.map(({ modelId }) => modelId),
		).toEqual(["own-id"]);
	});
});
