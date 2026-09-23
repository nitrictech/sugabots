import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { closePool, getDb } from "../../database/client.ts";
import { user, workspace } from "../../database/schema.ts";
import { closeDatabase, onPostgres } from "../../database/testing.ts";
import { aesCredentialCipher } from "./credentials.ts";
import { modelProviderStore } from "./store.ts";

/**
 * Recording what a provider offers, against real SQL.
 *
 * The upsert is the part a fake cannot check: whether a second discovery
 * updates a fetched row, leaves a manual one alone, and counts each exactly
 * once. Needs a migrated database and skips without one; CI always has one.
 */
describe.skipIf(!process.env.DATABASE_URL)("discovered models, against Postgres", () => {
	const db = getDb();
	const store = onPostgres(
		modelProviderStore(aesCredentialCipher(Buffer.alloc(32, 7).toString("base64"))),
	);

	let workspaceId: string;
	let userId: string;
	let providerId: string;

	afterAll(async () => {
		await closeDatabase();
		await closePool();
	});

	beforeEach(async () => {
		const stamp = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
		const [made] = await db
			.insert(workspace)
			.values({ name: `Test ${stamp}`, slug: `test-${stamp}` })
			.returning();
		const [person] = await db
			.insert(user)
			.values({ name: "Ada", email: `ada-${stamp}@example.com` })
			.returning();
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
