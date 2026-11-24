import type { ModelProviderUpdate, NewModelProvider } from "@sugabots/contracts";
import { ActionForbidden } from "@sugabots/contracts/errors/proofs";
import {
	ModelInUse,
	ProviderActivationRequiresCredential,
} from "@sugabots/contracts/errors/providers";
import type { InputOf, OperationName } from "@sugabots/contracts/operations";
import { and, eq, isNotNull, isNull } from "drizzle-orm";
import { Layer } from "effect";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { bot, member, membership, modelProvider, workspace } from "../../database/schema.ts";
import {
	closeDatabase,
	onDatabase,
	type Promised,
	runOnPostgres,
	servedOnPostgres,
} from "../../database/testing.ts";
import { servedOperations } from "../../operations/testing.ts";
import { authenticators, principals } from "../../proofs/world.test-support.ts";
import { BotStore } from "../../workspaces/bots/bot-store.ts";
import { createEgressUrlValidator, Egress, urlValidation } from "../network/egress.ts";
import { providerIn, providersIn } from "./model-provider-reads.ts";
import { ModelProviderStore } from "./model-provider-store.ts";

/**
 * Recording what a provider offers, against real SQL.
 *
 * The upsert is the part a fake cannot check: whether a second discovery
 * updates a fetched row, leaves a manual one alone, and counts each exactly
 * once. Needs a migrated database and skips without one; CI always has one.
 */
describe.skipIf(!process.env.DATABASE_URL)("model providers, against Postgres", () => {
	let store: Promised<ModelProviderStore.Interface>;
	beforeAll(async () => {
		store = await servedOnPostgres(ModelProviderStore.Service, ModelProviderStore.layer);
	});

	let signIn: ReturnType<typeof principals>["member"];
	beforeAll(async () => {
		signIn = principals(await authenticators()).member;
	});

	/**
	 * The model providers operations, called for the workspace's administrator
	 * signed in, by the names these cases use, with every provider answering
	 * `respond` for whichever address was asked.
	 */
	const setupWith = async (
		respond: (url: string) => Response | Promise<Response>,
		{ allowPrivateNetwork = true, as = memberId } = {},
	) => {
		const call = await servedOperations({
			egress: Layer.succeed(Egress.Service, {
				providers: { for: () => async (url) => respond(String(url)) },
				validateProviderUrl: urlValidation(createEgressUrlValidator({ allowPrivateNetwork })),
				oauth: async () => new Response(null, { status: 503 }),
				webFetch: async () => new Response(null, { status: 503 }),
			}),
		});
		const principal = await signIn(as);
		const operation =
			<Name extends OperationName>(name: Name) =>
			(input: InputOf<Name>) =>
				call(principal, name, input);
		return {
			list: operation("modelProviders.list"),
			listEnabledModels: operation("modelProviders.listEnabledModels"),
			setDefaultModel: operation("modelProviders.setDefaultModel"),
			create: operation("modelProviders.create"),
			update: operation("modelProviders.update"),
			test: operation("modelProviders.test"),
			discoverModels: operation("modelProviders.discoverModels"),
			updateModel: operation("modelProviders.updateModel"),
			switchOffModel: operation("modelProviders.switchOffModel"),
			switchOff: operation("modelProviders.switchOff"),
		};
	};

	const view = (providerId: string) => runOnPostgres(providerIn(workspaceId, providerId));
	const list = (inWorkspace: string) => runOnPostgres(providersIn(inWorkspace));
	const create = (provider: NewModelProvider) =>
		store.create(workspaceId, { createdById: memberId, provider });
	/** Switches a provider on as a fixture, the way only a passing test does in the product. */
	const switchOn = (id: string) =>
		onDatabase((db) =>
			db
				.update(modelProvider)
				.set({ active: true })
				.where(and(eq(modelProvider.id, id), eq(modelProvider.workspaceId, workspaceId))),
		);

	let workspaceId: string;
	let memberId: string;
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
		const [somebody] = await onDatabase((db) =>
			db
				.insert(member)
				.values({ name: "Ada", email: `ada-${stamp}@example.com` })
				.returning(),
		);
		if (!made || !somebody) throw new Error("could not create the test workspace");
		workspaceId = made.id;
		memberId = somebody.id;
		await onDatabase((db) =>
			db.insert(membership).values({ workspaceId, memberId, role: "admin" }),
		);
		await store.seedBuiltInProviders(workspaceId);
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
			const openai = (await list(workspaceId)).find(({ builtIn }) => builtIn === "openai");
			if (!openai) throw new Error("fixture");
			expect(openai).toMatchObject({ active: false, hasApiKey: false });
			if (key === "replacement") {
				await store.update(workspaceId, openai.id, { apiKey: "old-key" }, memberId);
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
			await store.update(workspaceId, providerId, { active: false }, memberId);
			await store.update(workspaceId, providerId, input, memberId);

			expect(await view(providerId)).toMatchObject({ active: false });
		},
	);

	it.each([
		{ httpStatus: 200, reachable: true, providerStatus: "connected" },
		{ httpStatus: 503, reachable: false, providerStatus: "error" },
	])(
		"records a local provider's provider test without switching it on: $httpStatus",
		async ({ httpStatus, reachable, providerStatus }) => {
			const ollama = (await list(workspaceId)).find(({ builtIn }) => builtIn === "ollama");
			if (!ollama) throw new Error("fixture");
			expect(ollama).toMatchObject({ active: false, hasApiKey: false });

			const setup = await setupWith(() => Response.json({ models: [] }, { status: httpStatus }));
			const result = await setup.test({ workspace: workspaceId, providerId: ollama.id });

			expect(result.reachable).toBe(reachable);
			expect(await view(ollama.id)).toMatchObject({
				active: false,
				status: providerStatus,
			});
		},
	);

	it("keeps a provider on when its provider test fails, and records why", async () => {
		await switchOn(providerId);
		const setup = await setupWith(() => new Response(null, { status: 401 }));

		expect(await setup.test({ workspace: workspaceId, providerId })).toMatchObject({
			reachable: false,
		});
		expect(await view(providerId)).toMatchObject({ active: true, status: "error" });
	});

	it("leaves a provider off after a provider test succeeds", async () => {
		const setup = await setupWith(() => Response.json({ data: [] }));

		expect(await setup.test({ workspace: workspaceId, providerId })).toMatchObject({
			reachable: true,
		});
		expect(await view(providerId)).toMatchObject({ active: false });
	});

	it("switches a provider on without asking it anything", async () => {
		const setup = await setupWith(() => {
			throw new Error("Switching a provider on sent a request");
		});

		const saved = await setup.update({
			workspace: workspaceId,
			providerId,
			changes: { active: true },
		});

		expect(saved).toMatchObject({ active: true });
	});

	it("names who connected a provider until its key is taken away, whether it is on or off", async () => {
		const openai = (await list(workspaceId)).find(({ builtIn }) => builtIn === "openai");
		if (!openai) throw new Error("fixture");
		expect(openai.connectedBy).toBeNull();
		const setup = await setupWith(() => Response.json({ data: [] }));
		const change = (changes: ModelProviderUpdate) =>
			setup.update({ workspace: workspaceId, providerId: openai.id, changes });

		await change({ apiKey: "secret" });
		expect(await view(openai.id)).toMatchObject({
			active: true,
			connectedBy: { name: "Ada", email: expect.stringMatching(/^ada-.*@example\.com$/) },
		});

		await change({ active: false });
		expect(await view(openai.id)).toMatchObject({ active: false, connectedBy: { name: "Ada" } });

		await change({ apiKey: null });
		expect(await view(openai.id)).toMatchObject({ connectedBy: null });
	});

	it("names who switched on a local provider, which takes no key, until it is switched off", async () => {
		const ollama = (await list(workspaceId)).find(({ builtIn }) => builtIn === "ollama");
		if (!ollama) throw new Error("fixture");
		expect(ollama.connectedBy).toBeNull();
		const setup = await setupWith(() => Response.json({ models: [] }));
		const change = (changes: ModelProviderUpdate) =>
			setup.update({ workspace: workspaceId, providerId: ollama.id, changes });

		await change({ active: true });
		expect(await view(ollama.id)).toMatchObject({ connectedBy: { name: "Ada" } });

		await change({ active: false });
		expect(await view(ollama.id)).toMatchObject({ connectedBy: null });
	});

	it("keeps a local provider given a key connected while it is switched off, as one that needs a key", async () => {
		const ollama = (await list(workspaceId)).find(({ builtIn }) => builtIn === "ollama");
		if (!ollama) throw new Error("fixture");
		const setup = await setupWith(() => Response.json({ models: [] }));
		const change = (changes: ModelProviderUpdate) =>
			setup.update({ workspace: workspaceId, providerId: ollama.id, changes });

		await change({ apiKey: "local-key" });
		await change({ active: false });

		expect(await view(ollama.id)).toMatchObject({ active: false, connectedBy: { name: "Ada" } });
	});

	it("names who next switches on a local provider whose key was taken away, not who gave the key", async () => {
		const ollama = (await list(workspaceId)).find(({ builtIn }) => builtIn === "ollama");
		if (!ollama) throw new Error("fixture");
		const [bob] = await onDatabase((db) =>
			db
				.insert(member)
				.values({ name: "Bob", email: `bob-${workspaceId}@example.com` })
				.returning(),
		);
		if (!bob) throw new Error("fixture");
		await onDatabase((db) =>
			db.insert(membership).values({ workspaceId, memberId: bob.id, role: "admin" }),
		);
		const respond = () => Response.json({ models: [] });
		await (await setupWith(respond)).update({
			workspace: workspaceId,
			providerId: ollama.id,
			changes: { apiKey: "local-key" },
		});

		const asBob = await setupWith(respond, { as: bob.id });
		const change = (changes: ModelProviderUpdate) =>
			asBob.update({ workspace: workspaceId, providerId: ollama.id, changes });

		// Taking the key away switches it off, even asked to switch it on.
		await change({ apiKey: null, active: true });
		expect(await view(ollama.id)).toMatchObject({ active: false, connectedBy: null });

		await change({ active: true });
		expect(await view(ollama.id)).toMatchObject({ active: true, connectedBy: { name: "Bob" } });
	});

	it("names nobody as who connected a provider once they have left the workspace, though they are in another", async () => {
		const [bob] = await onDatabase((db) =>
			db
				.insert(member)
				.values({ name: "Bob", email: `bob-${workspaceId}@example.com` })
				.returning(),
		);
		if (!bob) throw new Error("fixture");
		await onDatabase((db) =>
			db.insert(membership).values({ workspaceId, memberId: bob.id, role: "admin" }),
		);
		await (await setupWith(() => Response.json({ data: [] }), { as: bob.id })).update({
			workspace: workspaceId,
			providerId,
			changes: { apiKey: "bobs-key" },
		});
		expect(await view(providerId)).toMatchObject({ connectedBy: { name: "Bob" } });
		const [elsewhere] = await onDatabase((db) =>
			db
				.insert(workspace)
				.values({ name: "Elsewhere", slug: `elsewhere-${crypto.randomUUID()}` })
				.returning(),
		);
		if (!elsewhere) throw new Error("fixture");
		await onDatabase((db) =>
			db.insert(membership).values({ workspaceId: elsewhere.id, memberId: bob.id, role: "admin" }),
		);

		await onDatabase((db) =>
			db
				.delete(membership)
				.where(and(eq(membership.workspaceId, workspaceId), eq(membership.memberId, bob.id))),
		);

		expect(await view(providerId)).toMatchObject({ connectedBy: null });
	});

	it("does not let an in-flight successful test undo a manual deactivation", async () => {
		vi.useFakeTimers({ toFake: ["Date"] });
		try {
			vi.setSystemTime(new Date("2030-01-01T00:00:00Z"));
			await switchOn(providerId);
			const setup = await setupWith(async () => {
				vi.setSystemTime(new Date("2030-01-01T00:00:01Z"));
				await store.update(workspaceId, providerId, { active: false }, memberId);
				return Response.json({ data: [] });
			});

			await setup.test({ workspace: workspaceId, providerId });

			expect(await view(providerId)).toMatchObject({ active: false });
		} finally {
			vi.useRealTimers();
		}
	});

	it("does not reactivate a manually disabled provider when refreshing models", async () => {
		await store.update(workspaceId, providerId, { active: false }, memberId);
		const setup = await setupWith(() => Response.json({ data: [] }));

		await setup.discoverModels({ workspace: workspaceId, providerId });

		expect(await view(providerId)).toMatchObject({
			active: false,
			status: "connected",
		});
	});

	it("does not enable a provider that still needs an API key when testing", async () => {
		const openai = (await list(workspaceId)).find(({ builtIn }) => builtIn === "openai");
		if (!openai) throw new Error("fixture");
		const setup = await setupWith(() => Response.json({ data: [] }));

		expect(await setup.test({ workspace: workspaceId, providerId: openai.id })).toMatchObject({
			reachable: false,
		});
		expect(await view(openai.id)).toMatchObject({ active: false });
	});

	it("lets an editor see the models offered, and nothing more", async () => {
		const [sam] = await onDatabase((db) =>
			db
				.insert(member)
				.values({ name: "Sam", email: `sam-${crypto.randomUUID()}@example.com` })
				.returning(),
		);
		if (!sam) throw new Error("fixture");
		await onDatabase((db) =>
			db.insert(membership).values({ workspaceId, memberId: sam.id, role: "editor" }),
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

	describe("moving a provider's address", () => {
		const elsewhere = "https://elsewhere.example/v1";
		const withHeaders = async () => {
			const made = await create({
				name: "Headed gateway",
				baseUrl: "https://headed.example/v1",
				apiFormat: "openai",
				apiKey: "secret",
				customHeaders: [{ name: "x-team-token", value: "team-secret" }],
			});
			await switchOn(made.id);
			return made.id;
		};

		it("drops the key and headers, which would otherwise go to the new address, and switches it off", async () => {
			const headed = await withHeaders();

			await store.update(workspaceId, headed, { baseUrl: elsewhere }, memberId);

			expect(await view(headed)).toMatchObject({
				baseUrl: elsewhere,
				hasApiKey: false,
				customHeaders: [],
				active: false,
			});
			expect(await store.access(workspaceId, headed)).toBeUndefined();
		});

		it("keeps a key and headers given with the new address, off until tried", async () => {
			const headed = await withHeaders();

			await store.update(
				workspaceId,
				headed,
				{
					baseUrl: elsewhere,
					apiKey: "new-secret",
					customHeaders: [{ name: "x-team-token", value: "new-team-secret" }],
				},
				memberId,
			);

			expect(await view(headed)).toMatchObject({ active: false });
			expect(await store.access(workspaceId, headed)).toMatchObject({
				baseUrl: elsewhere,
				apiKey: "new-secret",
				headers: { "x-team-token": "new-team-secret" },
			});
		});

		it("keeps the key and headers when the address given is the one it has", async () => {
			const headed = await withHeaders();

			await store.update(workspaceId, headed, { baseUrl: "https://headed.example/v1" }, memberId);

			expect(await view(headed)).toMatchObject({ active: true });
			expect(await store.access(workspaceId, headed)).toMatchObject({
				apiKey: "secret",
				headers: { "x-team-token": "team-secret" },
			});
		});

		it("signs a subscription provider out", async () => {
			const chatgpt = (await list(workspaceId)).find(({ builtIn }) => builtIn === "chatgpt");
			if (!chatgpt) throw new Error("fixture");
			await store.saveOAuthTokens(workspaceId, chatgpt.id, {
				tokens: {
					access: "token",
					refresh: "refresh",
					expiresAt: Date.now() + 60_000,
					accountId: null,
				},
				signedInById: memberId,
			});

			await store.update(workspaceId, chatgpt.id, { baseUrl: elsewhere }, memberId);

			expect(await view(chatgpt.id)).toMatchObject({ signedIn: false });
			expect(await store.access(workspaceId, chatgpt.id)).toBeUndefined();
		});

		it("refuses to switch on at a new address without a key", async () => {
			const headed = await withHeaders();
			const setup = await setupWith(() => Response.json({ data: [] }));

			await expect(
				setup.update({
					workspace: workspaceId,
					providerId: headed,
					changes: { baseUrl: elsewhere, active: true },
				}),
			).rejects.toBeInstanceOf(ProviderActivationRequiresCredential);
			expect(await store.access(workspaceId, headed)).toMatchObject({ apiKey: "secret" });
		});

		it.each([
			{ httpStatus: 200, active: true },
			{ httpStatus: 503, active: false },
		])(
			"has a keyless provider on at its new address only once it answers there: $httpStatus",
			async ({ httpStatus, active }) => {
				const ollama = (await list(workspaceId)).find(({ builtIn }) => builtIn === "ollama");
				if (!ollama) throw new Error("fixture");
				await switchOn(ollama.id);
				const setup = await setupWith(() => Response.json({ models: [] }, { status: httpStatus }));

				await setup.update({
					workspace: workspaceId,
					providerId: ollama.id,
					changes: { baseUrl: "http://other-host:11434/v1" },
				});

				expect(await view(ollama.id)).toMatchObject({ active });
			},
		);
	});

	describe("under an egress policy that forbids private addresses", () => {
		const forbidding = () =>
			setupWith(() => Response.json({ data: [] }), { allowPrivateNetwork: false });

		it("refuses a local built-in provider, and stores nothing", async () => {
			const setup = await forbidding();
			const before = await list(workspaceId);

			await expect(
				setup.create({ workspace: workspaceId, provider: { builtIn: "lmstudio" } }),
			).rejects.toMatchObject({ _tag: "UrlNotAllowed" });
			expect(await list(workspaceId)).toEqual(before);
		});

		it("holds the seeded Ollama provider to the same policy when its address changes", async () => {
			const setup = await forbidding();
			const ollama = (await list(workspaceId)).find(({ builtIn }) => builtIn === "ollama");
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

	it("switches a keyless local provider on", async () => {
		const ollama = (await list(workspaceId)).find(({ builtIn }) => builtIn === "ollama");
		if (!ollama) throw new Error("fixture");
		const setup = await setupWith(() => {
			throw new Error("Switching a provider on sent a request");
		});

		const saved = await setup.update({
			workspace: workspaceId,
			providerId: ollama.id,
			changes: { active: true },
		});

		expect(saved).toMatchObject({ active: true });
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
		).rejects.toBeInstanceOf(ProviderActivationRequiresCredential);
		expect(await view(keyless.id)).toMatchObject({ active: false });
	});

	it("lists nothing it was not given, and seeds the built-in providers once when provisioned", async () => {
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
		await store.seedBuiltInProviders(fresh.id);
		const seeded = await list(fresh.id);
		await store.seedBuiltInProviders(fresh.id);

		expect(seeded.map(({ builtIn }) => builtIn)).toEqual(
			expect.arrayContaining(["openai", "ollama"]),
		);
		expect(await list(fresh.id)).toEqual(seeded);
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
		await store.syncDiscovered(workspaceId, providerId, [
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
		await store.syncDiscovered(workspaceId, other.id, [
			{ modelId: "shared-id", displayName: null, capabilities: [], contextLength: null },
		]);

		const synced = await store.syncDiscovered(workspaceId, providerId, [
			{ modelId: "shared-id", displayName: null, capabilities: [], contextLength: null },
			{ modelId: "own-id", displayName: null, capabilities: [], contextLength: null },
		]);
		expect(synced).toEqual({ added: 1, updated: 0 });
		expect((await view(providerId))?.models.map(({ modelId }) => modelId)).toEqual(["own-id"]);
	});

	describe("the default model and the system bots' models", () => {
		const botsOnPostgres = () => servedOnPostgres(BotStore.Service, BotStore.layer);

		/** Adds models to the gateway by hand, switches it on, and returns their row ids by model id. */
		const offerable = async (...modelIds: string[]) => {
			await store.addModels(
				workspaceId,
				providerId,
				modelIds.map((modelId) => ({
					modelId,
					displayName: null,
					capabilities: [],
					contextLength: null,
					source: "manual" as const,
				})),
			);
			await switchOn(providerId);
			const models = (await view(providerId))?.models ?? [];
			return Object.fromEntries(models.map(({ modelId, id }) => [modelId, id]));
		};

		const answering = () => setupWith(() => Response.json({ data: [] }));

		const systemBotModels = () =>
			onDatabase((db) =>
				db
					.select({ model: bot.model })
					.from(bot)
					.where(and(eq(bot.workspaceId, workspaceId), isNotNull(bot.systemBotKey))),
			).then((rows) => rows.map(({ model }) => model));

		it("makes the first model switched on the default and every system bot's and Personal Assistant's", async () => {
			const bots = await botsOnPostgres();
			await bots.createSystemBots({ workspaceId, createdById: memberId });
			// Made while the workspace offered no model, as for somebody who joined then.
			const assistant = await bots.provisionPersonalAssistant({ workspaceId, memberId });
			const ids = await offerable("first", "second");
			const setup = await answering();

			await setup.updateModel({
				workspace: workspaceId,
				providerId,
				modelId: ids.first ?? "",
				changes: { enabled: true },
			});
			await setup.updateModel({
				workspace: workspaceId,
				providerId,
				modelId: ids.second ?? "",
				changes: { enabled: true },
			});

			expect(await setup.listEnabledModels({ workspace: workspaceId })).toMatchObject({
				defaultModel: "first",
			});
			expect(await systemBotModels()).toEqual(["first"]);
			const [assistantModel] = await onDatabase((db) =>
				db.select({ model: bot.model }).from(bot).where(eq(bot.id, assistant.id)),
			);
			expect(assistantModel?.model).toBe("first");
		});

		it("refuses to switch the default off until another model replaces it", async () => {
			const ids = await offerable("first", "second");
			const setup = await answering();
			const enable = (modelId: string, enabled: boolean) =>
				setup.updateModel({
					workspace: workspaceId,
					providerId,
					modelId: ids[modelId] ?? "",
					changes: { enabled: enabled },
				});
			await enable("first", true);
			await enable("second", true);

			await expect(enable("first", false)).rejects.toBeInstanceOf(ModelInUse);
			await expect(
				setup.update({ workspace: workspaceId, providerId, changes: { active: false } }),
			).rejects.toBeInstanceOf(ModelInUse);
			await expect(
				setup.update({ workspace: workspaceId, providerId, changes: { apiKey: null } }),
			).rejects.toBeInstanceOf(ModelInUse);
			await expect(
				setup.update({
					workspace: workspaceId,
					providerId,
					changes: { baseUrl: "https://elsewhere.example/v1" },
				}),
			).rejects.toBeInstanceOf(ModelInUse);
			expect(await view(providerId)).toMatchObject({ active: true });

			await setup.setDefaultModel({ workspace: workspaceId, model: "second" });
			await enable("first", false);
			expect(await setup.listEnabledModels({ workspace: workspaceId })).toMatchObject({
				models: [{ modelId: "second" }],
				defaultModel: "second",
			});
		});

		it("refuses to switch off a model a system bot runs on", async () => {
			await (await botsOnPostgres()).createSystemBots({ workspaceId, createdById: memberId });
			const ids = await offerable("first", "second");
			const setup = await answering();
			for (const modelId of ["first", "second"]) {
				await setup.updateModel({
					workspace: workspaceId,
					providerId,
					modelId: ids[modelId] ?? "",
					changes: { enabled: true },
				});
			}
			await setup.setDefaultModel({ workspace: workspaceId, model: "second" });

			const refused = setup.updateModel({
				workspace: workspaceId,
				providerId,
				modelId: ids.first ?? "",
				changes: { enabled: false },
			});

			await expect(refused).rejects.toMatchObject({
				_tag: "ModelInUse",
				modelId: "first",
				holders: { workspaceDefault: false, systemBots: ["Compaction"] },
			});
		});

		describe("switching off a model bots run on", () => {
			/** Ready to switch off `first`: three models on, `third` the default, and two bots on `first`. */
			const withBotsOnFirst = async () => {
				const ids = await offerable("first", "second", "third");
				const setup = await answering();
				for (const modelId of Object.values(ids)) {
					await setup.updateModel({
						workspace: workspaceId,
						providerId,
						modelId,
						changes: { enabled: true },
					});
				}
				await setup.setDefaultModel({ workspace: workspaceId, model: "third" });
				await onDatabase((db) =>
					db.insert(bot).values(
						["Ada", "Grace"].map((name) => ({
							workspaceId,
							name,
							handle: name.toLowerCase(),
							color: "red" as const,
							eyes: "dot" as const,
							model: "first",
						})),
					),
				);
				return { ids, setup };
			};

			const botModels = () =>
				onDatabase((db) =>
					db
						.select({ model: bot.model })
						.from(bot)
						.where(and(eq(bot.workspaceId, workspaceId), isNull(bot.systemBotKey))),
				).then((rows) => rows.map(({ model }) => model));

			it("moves the bots to the chosen model as it switches the model off", async () => {
				const { ids, setup } = await withBotsOnFirst();

				await setup.switchOffModel({
					workspace: workspaceId,
					providerId,
					modelId: ids.first ?? "",
					moveBotsTo: "second",
				});

				expect(await botModels()).toEqual(["second", "second"]);
				expect(
					(await setup.listEnabledModels({ workspace: workspaceId })).models.map(
						({ modelId }) => modelId,
					),
				).toEqual(["second", "third"]);
			});

			it("moves the bots on a provider's models to another provider's as it switches off", async () => {
				const { setup } = await withBotsOnFirst();
				const other = await create({
					name: "Elsewhere",
					baseUrl: "https://elsewhere.example/v1",
					apiFormat: "openai",
					apiKey: "secret",
					customHeaders: [],
				});
				await store.addModels(workspaceId, other.id, [
					{
						modelId: "elsewhere",
						displayName: null,
						capabilities: [],
						contextLength: null,
						source: "manual",
					},
				]);
				await switchOn(other.id);
				const [elsewhere] = (await view(other.id))?.models ?? [];
				await setup.updateModel({
					workspace: workspaceId,
					providerId: other.id,
					modelId: elsewhere?.id ?? "",
					changes: { enabled: true },
				});
				await setup.setDefaultModel({ workspace: workspaceId, model: "elsewhere" });

				await setup.switchOff({
					workspace: workspaceId,
					providerId,
					moveBots: [{ from: "first", to: "elsewhere" }],
				});

				expect(await botModels()).toEqual(["elsewhere", "elsewhere"]);
				expect(await view(providerId)).toMatchObject({ active: false });
			});

			it("changes nothing when the model to move to is the one switching off", async () => {
				const { ids, setup } = await withBotsOnFirst();

				await expect(
					setup.switchOffModel({
						workspace: workspaceId,
						providerId,
						modelId: ids.first ?? "",
						moveBotsTo: "first",
					}),
				).rejects.toMatchObject({ _tag: "ModelNotEnabled" });
				expect(await botModels()).toEqual(["first", "first"]);
				expect(
					(await view(providerId))?.models.find(({ modelId }) => modelId === "first"),
				).toMatchObject({ enabled: true });
			});
		});

		describe("switching off the model new bots and system bots use", () => {
			/** `first` and `second` on, with `first` the default and every system bot's. */
			const withSettingsOnFirst = async () => {
				await (await botsOnPostgres()).createSystemBots({ workspaceId, createdById: memberId });
				const ids = await offerable("first", "second");
				const setup = await answering();
				for (const modelId of ["first", "second"]) {
					await setup.updateModel({
						workspace: workspaceId,
						providerId,
						modelId: ids[modelId] ?? "",
						changes: { enabled: true },
					});
				}
				return { ids, setup };
			};

			it("moves them to the chosen models as it switches the model off", async () => {
				const { ids, setup } = await withSettingsOnFirst();

				await setup.switchOffModel({
					workspace: workspaceId,
					providerId,
					modelId: ids.first ?? "",
					newBotsTo: "second",
					systemBotsTo: "second",
				});

				expect(await setup.listEnabledModels({ workspace: workspaceId })).toEqual({
					models: [expect.objectContaining({ modelId: "second" })],
					defaultModel: "second",
				});
				expect(await systemBotModels()).toEqual(["second"]);
			});

			it("refuses, changing nothing, when one is left on the model", async () => {
				const { ids, setup } = await withSettingsOnFirst();

				await expect(
					setup.switchOffModel({
						workspace: workspaceId,
						providerId,
						modelId: ids.first ?? "",
						newBotsTo: "second",
					}),
				).rejects.toMatchObject({
					_tag: "ModelInUse",
					holders: { workspaceDefault: false, systemBots: ["Compaction"] },
				});
				expect(await setup.listEnabledModels({ workspace: workspaceId })).toMatchObject({
					defaultModel: "first",
				});
			});
		});

		it("refuses a default the workspace does not offer", async () => {
			await offerable("first");
			const setup = await answering();

			await expect(
				setup.setDefaultModel({ workspace: workspaceId, model: "first" }),
			).rejects.toMatchObject({ _tag: "ModelNotEnabled" });
		});
	});
});
