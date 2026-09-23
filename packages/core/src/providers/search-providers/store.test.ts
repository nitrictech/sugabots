import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { closePool, getDb } from "../../database/client.ts";
import { workspace } from "../../database/schema.ts";
import { closeDatabase, onPostgres, type Promised } from "../../database/testing.ts";
import { aesCredentialCipher } from "../model-providers/credentials.ts";
import { type SearchProviderStore, searchProviderStore } from "./store.ts";

/**
 * The search provider store against Postgres: one per workspace, replaced
 * rather than added to, and what a turn is given to search with.
 */
describe.skipIf(!process.env.DATABASE_URL)("search providers, against Postgres", () => {
	const db = getDb();
	const cipher = aesCredentialCipher(Buffer.alloc(32, 7).toString("base64"));
	const providers: Promised<SearchProviderStore> = onPostgres(searchProviderStore(cipher));
	const userId = null as unknown as string;
	let workspaceId: string;

	afterAll(async () => {
		await closeDatabase();
		await closePool();
	});

	beforeEach(async () => {
		const suffix = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
		const [space] = await db
			.insert(workspace)
			.values({ name: `Search ${suffix}`, slug: `search-${suffix}` })
			.returning();
		if (!space) throw new Error("fixture");
		workspaceId = space.id;
	});

	it("lets Exa be switched on without a key, since its free endpoint answers then", async () => {
		const set = await providers.replace(workspaceId, userId, { preset: "exa", enabled: true });

		expect(set).toMatchObject({
			preset: "exa",
			name: "Exa",
			baseUrl: "https://api.exa.ai",
			enabled: true,
			hasApiKey: false,
			status: "untested",
		});
		expect(await providers.resolve(workspaceId)).toMatchObject({
			preset: "exa",
			apiKey: undefined,
		});
	});

	it("replaces the provider rather than adding a second", async () => {
		const first = await providers.replace(workspaceId, userId, { preset: "brave", apiKey: "k" });
		await providers.update(workspaceId, { enabled: true });

		const second = await providers.replace(workspaceId, userId, {
			preset: "searxng",
			baseUrl: "http://searx.local:8080",
		});

		expect(second.id).toBe(first.id);
		expect(second).toMatchObject({
			preset: "searxng",
			baseUrl: "http://searx.local:8080",
			hasApiKey: false,
			// Replacing is a fresh start: what was enabled and tested was another service.
			enabled: false,
			status: "untested",
		});
	});

	it("gives a turn the connection only while enabled and able to be called", async () => {
		await providers.replace(workspaceId, userId, { preset: "brave" });
		expect(await providers.get(workspaceId)).toMatchObject({ status: "missing_key" });
		expect(await providers.connection(workspaceId)).toBeUndefined();
		expect(await providers.resolve(workspaceId)).toBeUndefined();

		await providers.update(workspaceId, { apiKey: "brave-key" });
		expect(await providers.connection(workspaceId)).toMatchObject({ apiKey: "brave-key" });
		expect(await providers.resolve(workspaceId)).toBeUndefined();

		await providers.update(workspaceId, { enabled: true });
		expect(await providers.resolve(workspaceId)).toMatchObject({
			preset: "brave",
			baseUrl: "https://api.search.brave.com/res/v1",
			apiKey: "brave-key",
		});

		await providers.update(workspaceId, { apiKey: null });
		expect(await providers.resolve(workspaceId)).toBeUndefined();
	});

	it("records a test against the configuration it tested, and forgets it when that changes", async () => {
		await providers.replace(workspaceId, userId, { preset: "brave", apiKey: "k" });
		const connection = await providers.connection(workspaceId);
		if (!connection) throw new Error("no connection");

		await providers.recordTest(workspaceId, connection.configurationUpdatedAt, "HTTP 401");
		expect(await providers.get(workspaceId)).toMatchObject({
			status: "error",
			lastTestError: "HTTP 401",
		});

		await providers.update(workspaceId, { apiKey: "better-key" });
		expect(await providers.get(workspaceId)).toMatchObject({
			status: "untested",
			lastTestError: null,
		});
		// The old test was of an old key; recording it now would mislabel the new one.
		await providers.recordTest(workspaceId, connection.configurationUpdatedAt);
		expect(await providers.get(workspaceId)).toMatchObject({ status: "untested" });
	});
});
