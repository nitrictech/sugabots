import type { NewSearchProvider } from "@sugabots/contracts";
import { SearchProviderApiKeyRequired } from "@sugabots/contracts/errors/providers";
import { userText } from "@sugabots/errors";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { seedMember } from "../../authentication/seed.test-support.ts";
import {
	closeDatabase,
	type Promised,
	runOnPostgres,
	servedOnPostgres,
} from "../../database/testing.ts";
import { createTestWorkspace } from "../../database/workspace.test-support.ts";
import { searchProviderOf, toSearchProvider } from "./search-provider-reads.ts";
import { SearchProviderStore } from "./search-provider-store.ts";

/**
 * The search provider repository against Postgres: one per workspace, replaced
 * rather than added to, and what a turn is given to search with.
 */
describe.skipIf(!process.env.DATABASE_URL)("search providers, against Postgres", () => {
	let providers: Promised<SearchProviderStore.Interface>;
	let workspaceId: string;
	let providerId: string;
	let memberId: string;

	beforeAll(async () => {
		providers = await servedOnPostgres(SearchProviderStore.Service, SearchProviderStore.layer);
	});

	afterAll(async () => {
		await closeDatabase();
	});

	const replace = async (provider: NewSearchProvider) => {
		const row = await providers.replace(workspaceId, {
			createdById: memberId,
			provider,
		});
		providerId = row.id;
		return toSearchProvider(row);
	};
	const shown = () => runOnPostgres(searchProviderOf(workspaceId));

	beforeEach(async () => {
		const suffix = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
		const space = await createTestWorkspace({ name: `Search ${suffix}`, slug: `search-${suffix}` });
		workspaceId = space.id;
		memberId = await seedMember(workspaceId, "admin");
	});

	it("lets Exa be switched on without a key, since its free endpoint answers then", async () => {
		const set = await replace({ builtIn: "exa", enabled: true });

		expect(set).toMatchObject({
			builtIn: "exa",
			name: "Exa",
			baseUrl: "https://api.exa.ai",
			enabled: true,
			hasApiKey: false,
			status: "untested",
		});
		expect(await providers.resolve(workspaceId)).toMatchObject({
			builtIn: "exa",
			apiKey: undefined,
		});
	});

	it("replaces the provider rather than adding a second", async () => {
		const first = await replace({ builtIn: "brave", apiKey: "k" });
		await providers.update(workspaceId, providerId, { enabled: true });

		const second = await replace({
			builtIn: "searxng",
			baseUrl: "http://searx.local:8080",
		});

		expect(second.id).toBe(first.id);
		expect(second).toMatchObject({
			builtIn: "searxng",
			baseUrl: "http://searx.local:8080",
			hasApiKey: false,
			// Replacing is a fresh start: what was enabled and tested was another service.
			enabled: false,
			status: "untested",
		});
	});

	it("gives a turn the provider access only while enabled and able to be called", async () => {
		await replace({ builtIn: "brave" });
		expect(await shown()).toMatchObject({ status: "missing_key" });
		expect(await providers.access(workspaceId, providerId)).toBeUndefined();
		expect(await providers.resolve(workspaceId)).toBeUndefined();

		await providers.update(workspaceId, providerId, { apiKey: "brave-key" });
		expect(await providers.access(workspaceId, providerId)).toMatchObject({ apiKey: "brave-key" });
		expect(await providers.resolve(workspaceId)).toBeUndefined();

		await providers.update(workspaceId, providerId, { enabled: true });
		expect(await providers.resolve(workspaceId)).toMatchObject({
			builtIn: "brave",
			baseUrl: "https://api.search.brave.com/res/v1",
			apiKey: "brave-key",
		});

		await providers.update(workspaceId, providerId, { apiKey: null });
		expect(await providers.resolve(workspaceId)).toBeUndefined();
		expect(await shown()).toMatchObject({ enabled: false, status: "missing_key" });
	});

	it("refuses to switch search on for a built-in provider that needs a key it does not have", async () => {
		await replace({ builtIn: "brave" });

		await expect(
			providers.update(workspaceId, providerId, { enabled: true }),
		).rejects.toBeInstanceOf(SearchProviderApiKeyRequired);
		await expect(replace({ builtIn: "brave", enabled: true })).rejects.toBeInstanceOf(
			SearchProviderApiKeyRequired,
		);
		expect(await shown()).toMatchObject({ enabled: false });
	});

	it("records a test against the configuration it tested, and forgets it when that changes", async () => {
		await replace({ builtIn: "brave", apiKey: "k" });
		const access = await providers.access(workspaceId, providerId);
		if (!access) throw new Error("no access");

		await providers.recordTest(
			workspaceId,
			providerId,
			access.configurationUpdatedAt,
			userText`Brave Search answered HTTP ${401}`,
		);
		expect(await shown()).toMatchObject({
			status: "error",
			lastTestError: "Brave Search answered HTTP 401",
		});

		await providers.update(workspaceId, providerId, { apiKey: "better-key" });
		expect(await shown()).toMatchObject({
			status: "untested",
			lastTestError: null,
		});
		// The old test was of an old key; recording it now would mislabel the new one.
		await providers.recordTest(workspaceId, providerId, access.configurationUpdatedAt);
		expect(await shown()).toMatchObject({ status: "untested" });
	});

	describe("moving the provider's address", () => {
		const braveAt = "https://api.search.brave.com/res/v1";

		it("drops the stored key, which would otherwise go to the new address, and switches search off", async () => {
			await replace({ builtIn: "brave", apiKey: "brave-key", enabled: true });

			await providers.update(workspaceId, providerId, { baseUrl: "https://elsewhere.example" });

			expect(await providers.access(workspaceId, providerId)).toBeUndefined();
			expect(await shown()).toMatchObject({ hasApiKey: false, enabled: false });
		});

		it("refuses to keep search on at a new address without a key", async () => {
			await replace({ builtIn: "brave", apiKey: "brave-key", enabled: true });

			await expect(
				providers.update(workspaceId, providerId, {
					baseUrl: "https://elsewhere.example",
					enabled: true,
				}),
			).rejects.toBeInstanceOf(SearchProviderApiKeyRequired);
			expect(await providers.resolve(workspaceId)).toMatchObject({
				baseUrl: braveAt,
				apiKey: "brave-key",
			});
		});

		it("keeps a key given with the new address", async () => {
			await replace({ builtIn: "brave", apiKey: "brave-key", enabled: true });

			await providers.update(workspaceId, providerId, {
				baseUrl: "https://elsewhere.example",
				apiKey: "new-key",
			});

			expect(await providers.resolve(workspaceId)).toMatchObject({
				baseUrl: "https://elsewhere.example",
				apiKey: "new-key",
			});
		});

		it("keeps the key when the address given is the one it has", async () => {
			await replace({ builtIn: "brave", apiKey: "brave-key", enabled: true });

			await providers.update(workspaceId, providerId, { baseUrl: braveAt });

			expect(await providers.resolve(workspaceId)).toMatchObject({ apiKey: "brave-key" });
		});
	});
});
