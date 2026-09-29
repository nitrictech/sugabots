import type { NewModelProvider } from "@sugabots/contracts";
import { and, eq } from "drizzle-orm";
import { Effect, Layer } from "effect";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { ActionForbidden } from "../../authorization/access.ts";
import { modelProvider, user, workspace, workspaceMember } from "../../database/schema.ts";
import {
	closeDatabase,
	onDatabase,
	type Promised,
	runOnPostgres,
	servedOnPostgres,
} from "../../database/testing.ts";
import { servedOnPostgresAs } from "../../workspaces/testing.ts";
import { createEgressUrlValidator, Egress, urlValidation } from "../network/egress.ts";
import { providerIn, providersIn } from "./model-provider-reads.ts";
import { ModelProviderRepository } from "./model-provider-repository.ts";
import { ModelProviderSetup } from "./model-provider-setup.ts";
import { seedEveryWorkspace } from "./preset-seeding.ts";

/**
 * Recording what a provider offers, against real SQL.
 *
 * The upsert is the part a fake cannot check: whether a second discovery
 * updates a fetched row, leaves a manual one alone, and counts each exactly
 * once. Needs a migrated database and skips without one; CI always has one.
 */
describe.skipIf(!process.env.DATABASE_URL)("model providers, against Postgres", () => {
	let repository: Promised<ModelProviderRepository.Interface>;
	beforeAll(async () => {
		repository = await servedOnPostgres(
			ModelProviderRepository.Service,
			ModelProviderRepository.layer,
		);
	});

	/**
	 * The setup as the workspace's administrator, with every provider
	 * answering `respond` for whichever address was asked.
	 */
	const setupWith = async (
		respond: (url: string) => Response | Promise<Response>,
		{ allowPrivateNetwork = true, as = userId } = {},
	) =>
		(
			await servedOnPostgresAs(
				ModelProviderSetup.Service,
				ModelProviderSetup.layer.pipe(
					Layer.provide([
						Layer.succeed(Egress.Service, {
							providers: { for: () => async (url) => respond(String(url)) },
							validateProviderUrl: urlValidation(createEgressUrlValidator({ allowPrivateNetwork })),
							oauth: async () => new Response(null, { status: 503 }),
							webFetch: async () => new Response(null, { status: 503 }),
						}),
					]),
				),
			)
		)(as);

	const view = (providerId: string) => runOnPostgres(providerIn(workspaceId, providerId));
	const list = (inWorkspace: string) => runOnPostgres(providersIn(inWorkspace));
	const create = (provider: NewModelProvider) =>
		repository.create(workspaceId, { createdById: userId, provider });
	/** Switches a provider on as a fixture, the way only a passing test does in the product. */
	const switchOn = (id: string) =>
		onDatabase((db) =>
			db
				.update(modelProvider)
				.set({ active: true })
				.where(and(eq(modelProvider.id, id), eq(modelProvider.workspaceId, workspaceId))),
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
		await onDatabase((db) =>
			db.insert(workspaceMember).values({ workspaceId, userId, role: "admin" }),
		);
		await repository.seedPresets(workspaceId);
		const provider = await create({
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
			const setup = await setupWith(() => Response.json({ data: [] }, { status: httpStatus }));
			const created = await setup.create({
				workspace: workspaceId,
				provider: {
					name: "New gateway",
					baseUrl: "https://new.example/v1",
					apiFormat: "openai",
					apiKey: "new-key",
					customHeaders: [],
				},
			});

			expect(created).toMatchObject({ active, hasApiKey: true, status });
			expect(await view(created.id)).toMatchObject({ active, status });
		},
	);

	it.each(["first", "replacement"])(
		"keeps a rejected %s API key saved but disabled",
		async (key) => {
			const openai = (await list(workspaceId)).find(({ preset }) => preset === "openai");
			if (!openai) throw new Error("fixture");
			expect(openai).toMatchObject({ active: false, hasApiKey: false });
			if (key === "replacement") {
				await repository.update(workspaceId, openai.id, { apiKey: "old-key" });
				await switchOn(openai.id);
			}
			let activeDuringCheck: boolean | undefined;
			const setup = await setupWith(async () => {
				activeDuringCheck = (await view(openai.id))?.active;
				return new Response(null, { status: 401 });
			});

			const saved = await setup.update({
				workspace: workspaceId,
				providerId: openai.id,
				changes: { apiKey: "secret" },
			});

			expect(activeDuringCheck).toBe(false);
			expect(saved).toMatchObject({ active: false, hasApiKey: true, status: "error" });
			expect(await view(openai.id)).toMatchObject({
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
			const setup = await setupWith(() => Response.json({ data: [] }));
			const saved = await setup.update({
				workspace: workspaceId,
				providerId,
				changes: { apiKey: "replacement", active: requestedActive },
			});

			expect(saved).toMatchObject({ active, status: "connected" });
			expect(await view(providerId)).toMatchObject({ active });
		},
	);

	it.each([{ baseUrl: "https://other.example/v1" }, { apiKey: null }])(
		"does not enable a disabled provider for an unrelated update: %j",
		async (input) => {
			await repository.update(workspaceId, providerId, { active: false });
			await repository.update(workspaceId, providerId, input);

			expect(await view(providerId)).toMatchObject({ active: false });
		},
	);

	it.each([
		{ httpStatus: 200, reachable: true, active: true, connectionStatus: "connected" },
		{ httpStatus: 503, reachable: false, active: false, connectionStatus: "error" },
	])(
		"enables a local provider only after a successful connection test: $httpStatus",
		async ({ httpStatus, reachable, active, connectionStatus }) => {
			const ollama = (await list(workspaceId)).find(({ preset }) => preset === "ollama");
			if (!ollama) throw new Error("fixture");
			expect(ollama).toMatchObject({ active: false, hasApiKey: false });

			const setup = await setupWith(() => Response.json({ models: [] }, { status: httpStatus }));
			const result = await setup.test({ workspace: workspaceId, providerId: ollama.id });

			expect(result.reachable).toBe(reachable);
			expect(await view(ollama.id)).toMatchObject({
				active,
				status: connectionStatus,
			});
		},
	);

	it("re-enables a configured provider when testing its connection", async () => {
		await repository.update(workspaceId, providerId, { active: false });
		const setup = await setupWith(() => Response.json({ data: [] }));

		expect(await setup.test({ workspace: workspaceId, providerId })).toMatchObject({
			reachable: true,
		});
		expect(await view(providerId)).toMatchObject({ active: true });
	});

	it("disables an enabled provider when its key is rejected during a connection test", async () => {
		await switchOn(providerId);
		const setup = await setupWith(() => new Response(null, { status: 401 }));

		expect(await setup.test({ workspace: workspaceId, providerId })).toMatchObject({
			reachable: false,
		});
		expect(await view(providerId)).toMatchObject({
			active: false,
			status: "error",
		});
	});

	it("does not allow manual activation to bypass a rejected key", async () => {
		const setup = await setupWith(() => new Response(null, { status: 401 }));

		const saved = await setup.update({
			workspace: workspaceId,
			providerId,
			changes: { active: true },
		});

		expect(saved).toMatchObject({ active: false, status: "error" });
	});

	it("disables a provider whose enabled model refuses to answer after its model listing succeeds", async () => {
		await repository.addModels(workspaceId, providerId, [
			{
				modelId: "test-model",
				displayName: null,
				capabilities: [],
				contextLength: null,
				source: "manual",
			},
		]);
		const [configured] = (await view(providerId))?.models ?? [];
		if (!configured) throw new Error("fixture");
		await repository.setModelEnabled(workspaceId, providerId, [configured.id], true);
		// The listing answers; asking the model refuses the key.
		const setup = await setupWith((url) =>
			url.endsWith("/chat/completions")
				? Response.json({ error: { message: "API key rejected" } }, { status: 401 })
				: Response.json({ data: [] }),
		);

		expect(await setup.test({ workspace: workspaceId, providerId })).toMatchObject({
			reachable: false,
		});
		expect(await view(providerId)).toMatchObject({
			active: false,
			status: "error",
			lastTestError: "test-model: The model provider refused the request. Check its API key.",
		});
	});

	it("does not let an in-flight successful test undo a manual deactivation", async () => {
		vi.useFakeTimers({ toFake: ["Date"] });
		try {
			vi.setSystemTime(new Date("2030-01-01T00:00:00Z"));
			await switchOn(providerId);
			const setup = await setupWith(async () => {
				vi.setSystemTime(new Date("2030-01-01T00:00:01Z"));
				await repository.update(workspaceId, providerId, { active: false });
				return Response.json({ data: [] });
			});

			await setup.test({ workspace: workspaceId, providerId });

			expect(await view(providerId)).toMatchObject({ active: false });
		} finally {
			vi.useRealTimers();
		}
	});

	it("does not reactivate a manually disabled provider when refreshing models", async () => {
		await repository.update(workspaceId, providerId, { active: false });
		const setup = await setupWith(() => Response.json({ data: [] }));

		await setup.fetchModels({ workspace: workspaceId, providerId });

		expect(await view(providerId)).toMatchObject({
			active: false,
			status: "connected",
		});
	});

	it("does not enable a provider that still needs an API key when testing", async () => {
		const openai = (await list(workspaceId)).find(({ preset }) => preset === "openai");
		if (!openai) throw new Error("fixture");
		const setup = await setupWith(() => Response.json({ data: [] }));

		expect(await setup.test({ workspace: workspaceId, providerId: openai.id })).toMatchObject({
			reachable: false,
		});
		expect(await view(openai.id)).toMatchObject({ active: false });
	});

	it("lets a member see the models offered, and nothing more", async () => {
		const [sam] = await onDatabase((db) =>
			db
				.insert(user)
				.values({ name: "Sam", email: `sam-${crypto.randomUUID()}@example.com` })
				.returning(),
		);
		if (!sam) throw new Error("fixture");
		await onDatabase((db) =>
			db.insert(workspaceMember).values({ workspaceId, userId: sam.id, role: "member" }),
		);
		const setup = await setupWith(() => Response.json({ data: [] }), { as: sam.id });

		expect(await setup.listEnabledModels({ workspace: workspaceId })).toMatchObject({
			models: [],
		});
		await expect(setup.list({ workspace: workspaceId })).rejects.toBeInstanceOf(ActionForbidden);
		await expect(
			setup.update({ workspace: workspaceId, providerId, changes: { apiKey: "stolen" } }),
		).rejects.toBeInstanceOf(ActionForbidden);
	});

	describe("under an egress policy that forbids private addresses", () => {
		const forbidding = () =>
			setupWith(() => Response.json({ data: [] }), { allowPrivateNetwork: false });

		it("refuses a local preset, and stores nothing", async () => {
			const setup = await forbidding();
			const before = await list(workspaceId);

			await expect(
				setup.create({ workspace: workspaceId, provider: { preset: "lmstudio" } }),
			).rejects.toMatchObject({ _tag: "UrlNotAllowed" });
			expect(await list(workspaceId)).toEqual(before);
		});

		it("holds the seeded Ollama provider to the same policy when its address changes", async () => {
			const setup = await forbidding();
			const ollama = (await list(workspaceId)).find(({ preset }) => preset === "ollama");
			if (!ollama) throw new Error("fixture");

			await expect(
				setup.update({
					workspace: workspaceId,
					providerId: ollama.id,
					changes: { baseUrl: "http://192.168.1.10:11434/v1" },
				}),
			).rejects.toMatchObject({ _tag: "UrlNotAllowed" });
			expect(await view(ollama.id)).toMatchObject({ baseUrl: ollama.baseUrl });
		});
	});

	it("switches a keyless local provider on once a test of it succeeds", async () => {
		const ollama = (await list(workspaceId)).find(({ preset }) => preset === "ollama");
		if (!ollama) throw new Error("fixture");
		const setup = await setupWith(() => Response.json({ models: [] }));

		const saved = await setup.update({
			workspace: workspaceId,
			providerId: ollama.id,
			changes: { active: true },
		});

		expect(saved).toMatchObject({ active: true, status: "connected" });
	});

	it("refuses to switch on a custom provider that has no key", async () => {
		const keyless = await create({
			name: "Keyless",
			baseUrl: "https://keyless.example/v1",
			apiFormat: "openai",
			customHeaders: [],
		});
		const setup = await setupWith(() => Response.json({ data: [] }));

		await expect(
			setup.update({ workspace: workspaceId, providerId: keyless.id, changes: { active: true } }),
		).rejects.toBeInstanceOf(ModelProviderSetup.ProviderActivationRequiresCredential);
		expect(await view(keyless.id)).toMatchObject({ active: false });
	});

	it("catches every workspace up at start-up, and changes nothing the second time", async () => {
		const seedAll = () =>
			runOnPostgres(seedEveryWorkspace.pipe(Effect.provide(ModelProviderRepository.layer)));
		const [fresh] = await onDatabase((db) =>
			db
				.insert(workspace)
				.values({
					name: "Fresh",
					slug: `fresh-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
				})
				.returning(),
		);
		if (!fresh) throw new Error("fixture");
		expect(await list(fresh.id)).toEqual([]);

		await seedAll();
		const seeded = await list(fresh.id);
		expect(seeded.map(({ preset }) => preset)).toEqual(
			expect.arrayContaining(["openai", "ollama"]),
		);

		await seedAll();

		expect(await list(fresh.id)).toEqual(seeded);
	});

	it("lists nothing it was not given, and seeds the presets once when provisioned", async () => {
		const [fresh] = await onDatabase((db) =>
			db
				.insert(workspace)
				.values({
					name: "Fresh",
					slug: `fresh-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
				})
				.returning(),
		);
		if (!fresh) throw new Error("fixture");

		expect(await list(fresh.id)).toEqual([]);
		await repository.seedPresets(fresh.id);
		const seeded = await list(fresh.id);
		await repository.seedPresets(fresh.id);

		expect(seeded.map(({ preset }) => preset)).toEqual(
			expect.arrayContaining(["openai", "ollama"]),
		);
		expect(await list(fresh.id)).toEqual(seeded);
	});

	it("adds what is new, updates what changed, and counts each once", async () => {
		const first = await repository.syncDiscovered(workspaceId, providerId, [
			{ modelId: "alpha", displayName: "Alpha", capabilities: [], contextLength: null },
			{ modelId: "beta", displayName: null, capabilities: ["tools"], contextLength: 8_000 },
		]);
		expect(first).toEqual({ added: 2, updated: 0 });

		const second = await repository.syncDiscovered(workspaceId, providerId, [
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

		const provider = await view(providerId);
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
		await repository.syncDiscovered(workspaceId, providerId, [
			{
				modelId: "alpha",
				displayName: "Alpha",
				capabilities: ["tools", "vision"],
				contextLength: null,
			},
		]);
		const [alpha] = (await view(providerId))?.models ?? [];
		if (!alpha) throw new Error("fixture");

		expect(
			await repository.updateModel(workspaceId, providerId, alpha.id, {
				disabledCapabilities: ["vision"],
			}),
		).toBe(1);
		const synced = await repository.syncDiscovered(workspaceId, providerId, [
			{
				modelId: "alpha",
				displayName: "Alpha",
				capabilities: ["tools", "vision", "audio"],
				contextLength: 32_000,
			},
		]);

		expect(synced).toEqual({ added: 0, updated: 1 });
		expect((await view(providerId))?.models).toMatchObject([
			{
				modelId: "alpha",
				capabilities: ["tools", "vision", "audio"],
				disabledCapabilities: ["vision"],
				contextLength: 32_000,
			},
		]);
	});

	it("leaves a model somebody added by hand as they wrote it", async () => {
		await repository.addModels(workspaceId, providerId, [
			{
				modelId: "hand-made",
				displayName: "Mine",
				capabilities: ["tools"],
				contextLength: 4_000,
				source: "manual",
			},
		]);

		const synced = await repository.syncDiscovered(workspaceId, providerId, [
			{ modelId: "hand-made", displayName: null, capabilities: [], contextLength: null },
		]);
		expect(synced).toEqual({ added: 0, updated: 0 });

		const provider = await view(providerId);
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
		const other = await create({
			name: `Other ${providerId}`,
			baseUrl: "https://other.example/v1",
			apiFormat: "openai",
			apiKey: "secret",
			customHeaders: [],
		});
		await repository.syncDiscovered(workspaceId, other.id, [
			{ modelId: "shared-id", displayName: null, capabilities: [], contextLength: null },
		]);

		const synced = await repository.syncDiscovered(workspaceId, providerId, [
			{ modelId: "shared-id", displayName: null, capabilities: [], contextLength: null },
			{ modelId: "own-id", displayName: null, capabilities: [], contextLength: null },
		]);
		expect(synced).toEqual({ added: 1, updated: 0 });
		expect((await view(providerId))?.models.map(({ modelId }) => modelId)).toEqual(["own-id"]);
	});
});
