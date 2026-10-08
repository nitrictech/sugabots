import type { NewSearchProvider } from "@sugabots/contracts";
import { userText } from "@sugabots/errors";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { workspace } from "../../database/schema.ts";
import {
	closeDatabase,
	onDatabase,
	type Promised,
	runOnPostgres,
	servedOnPostgres,
} from "../../database/testing.ts";
import { searchProviderOf, toSearchProvider } from "./search-provider-reads.ts";
import { SearchProviderRepository } from "./search-provider-repository.ts";

/**
 * The search provider repository against Postgres: one per workspace, replaced
 * rather than added to, and what a turn is given to search with.
 */
describe.skipIf(!process.env.DATABASE_URL)("search providers, against Postgres", () => {
	let providers: Promised<SearchProviderRepository.Interface>;
	let workspaceId: string;

	beforeAll(async () => {
		providers = await servedOnPostgres(
			SearchProviderRepository.Service,
			SearchProviderRepository.layer,
		);
	});

	afterAll(async () => {
		await closeDatabase();
	});

	const replace = async (provider: NewSearchProvider) =>
		toSearchProvider(
			await providers.replace(workspaceId, {
				createdById: null as unknown as string,
				provider,
			}),
		);
	const shown = () => runOnPostgres(searchProviderOf(workspaceId));

	beforeEach(async () => {
		const suffix = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
		const [space] = await onDatabase((db) =>
			db
				.insert(workspace)
				.values({ name: `Search ${suffix}`, slug: `search-${suffix}` })
				.returning(),
		);
		if (!space) throw new Error("fixture");
		workspaceId = space.id;
	});

	it("lets Exa be switched on without a key, since its free endpoint answers then", async () => {
		const set = await replace({ preset: "exa", enabled: true });

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
		const first = await replace({ preset: "brave", apiKey: "k" });
		await providers.update(workspaceId, { enabled: true });

		const second = await replace({
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
		await replace({ preset: "brave" });
		expect(await shown()).toMatchObject({ status: "missing_key" });
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
		expect(await shown()).toMatchObject({ enabled: false, status: "missing_key" });
	});

	it("refuses to switch search on for a preset that needs a key it does not have", async () => {
		await replace({ preset: "brave" });

		await expect(providers.update(workspaceId, { enabled: true })).rejects.toBeInstanceOf(
			SearchProviderRepository.SearchProviderApiKeyRequired,
		);
		await expect(replace({ preset: "brave", enabled: true })).rejects.toBeInstanceOf(
			SearchProviderRepository.SearchProviderApiKeyRequired,
		);
		expect(await shown()).toMatchObject({ enabled: false });
	});

	it("records a test against the configuration it tested, and forgets it when that changes", async () => {
		await replace({ preset: "brave", apiKey: "k" });
		const connection = await providers.connection(workspaceId);
		if (!connection) throw new Error("no connection");

		await providers.recordTest(
			workspaceId,
			connection.configurationUpdatedAt,
			userText`Brave Search answered HTTP ${401}`,
		);
		expect(await shown()).toMatchObject({
			status: "error",
			lastTestError: "Brave Search answered HTTP 401",
		});

		await providers.update(workspaceId, { apiKey: "better-key" });
		expect(await shown()).toMatchObject({
			status: "untested",
			lastTestError: null,
		});
		// The old test was of an old key; recording it now would mislabel the new one.
		await providers.recordTest(workspaceId, connection.configurationUpdatedAt);
		expect(await shown()).toMatchObject({ status: "untested" });
	});
});
