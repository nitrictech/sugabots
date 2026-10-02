import type { NewSandboxProvider } from "@sugabots/contracts";
import { Effect, Exit } from "effect";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { user, workspace } from "../database/schema.ts";
import { closeDatabase, onDatabase, runOnPostgres } from "../database/testing.ts";
import { SandboxProviderRepository } from "./sandbox-provider-repository.ts";

/**
 * A workspace's sandbox providers against Postgres: as many as it likes, at
 * most one enabled, and never one enabled without what it needs.
 */
describe.skipIf(!process.env.DATABASE_URL)("sandbox providers, against Postgres", () => {
	let providers: SandboxProviderRepository.Interface;
	let workspaceId: string;
	let createdById: string;

	beforeAll(async () => {
		providers = await runOnPostgres(
			Effect.provide(SandboxProviderRepository.Service, SandboxProviderRepository.layer),
		);
	});

	afterAll(async () => {
		await closeDatabase();
	});

	beforeEach(async () => {
		const suffix = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
		const [space] = await onDatabase((db) =>
			db
				.insert(workspace)
				.values({ name: `Providers ${suffix}`, slug: `providers-${suffix}` })
				.returning(),
		);
		const [person] = await onDatabase((db) =>
			db
				.insert(user)
				.values({ name: "Sam", email: `providers-${suffix}@example.com` })
				.returning(),
		);
		if (!space || !person) throw new Error("fixture");
		workspaceId = space.id;
		createdById = person.id;
	});

	const create = (provider: NewSandboxProvider) =>
		runOnPostgres(providers.create(workspaceId, { createdById, provider }));
	const createExit = (provider: NewSandboxProvider) =>
		runOnPostgres(Effect.exit(providers.create(workspaceId, { createdById, provider })));
	const enabledIds = async () =>
		(await runOnPostgres(providers.list(workspaceId)))
			.filter((row) => row.enabled)
			.map((row) => row.id);

	it("keeps one provider enabled, the one enabled last", async () => {
		const first = await create({ preset: "opensandbox", enabled: true, apiKey: "one" });
		const second = await create({ preset: "e2b", enabled: true, apiKey: "two" });

		expect(await enabledIds()).toEqual([second.id]);

		await runOnPostgres(providers.update(workspaceId, first.id, { enabled: true }));

		expect(await enabledIds()).toEqual([first.id]);
		expect((await runOnPostgres(providers.enabled(workspaceId)))?.id).toBe(first.id);
	});

	it("refuses to enable a provider without a key", async () => {
		const exit = await createExit({ preset: "e2b", enabled: true });

		expect(Exit.isFailure(exit) && exit.toString()).toContain("SandboxProviderIncomplete");
	});

	it("refuses to enable E2B Embed with only one of its addresses", async () => {
		const exit = await createExit({
			preset: "e2b",
			enabled: true,
			apiKey: "key",
			baseUrl: "http://localhost:3000",
		});

		expect(Exit.isFailure(exit) && exit.toString()).toContain("SandboxProviderIncomplete");
	});

	it("disables a provider whose key is removed", async () => {
		const provider = await create({ preset: "opensandbox", enabled: true, apiKey: "key" });

		const updated = await runOnPostgres(
			providers.update(workspaceId, provider.id, { apiKey: null }),
		);

		expect(updated?.enabled).toBe(false);
		expect(await runOnPostgres(providers.enabled(workspaceId))).toBeUndefined();
	});

	it("gives OpenSandbox its usual address, and the default image until another is set", async () => {
		const provider = await create({ preset: "opensandbox", apiKey: "key" });
		const imageOf = async () => {
			const configured = await runOnPostgres(providers.connection(workspaceId, provider.id));
			return configured?.connection.provider === "opensandbox"
				? configured.connection.image
				: undefined;
		};

		expect(provider.baseUrl).toBe("http://localhost:8090");
		expect(await imageOf()).toBe("ghcr.io/nitrictech/sugabots-sandbox:latest");

		await runOnPostgres(providers.update(workspaceId, provider.id, { image: "debian:trixie" }));
		expect(await imageOf()).toBe("debian:trixie");

		await runOnPostgres(providers.update(workspaceId, provider.id, { image: null }));
		expect(await imageOf()).toBe("ghcr.io/nitrictech/sugabots-sandbox:latest");
	});
});
