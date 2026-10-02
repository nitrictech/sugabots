import type { NewSandboxProvider } from "@sugabots/contracts";
import { Effect, Exit } from "effect";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { user, workspace } from "../database/schema.ts";
import { closeDatabase, onDatabase, runOnPostgres } from "../database/testing.ts";
import { toSandboxProvider } from "./sandbox-provider-reads.ts";
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
		const first = await create({
			settings: { preset: "opensandbox" },
			enabled: true,
			apiKey: "one",
		});
		const second = await create({ settings: { preset: "e2b" }, enabled: true, apiKey: "two" });

		expect(await enabledIds()).toEqual([second.id]);

		await runOnPostgres(providers.update(workspaceId, first.id, { enabled: true }));

		expect(await enabledIds()).toEqual([first.id]);
		expect((await runOnPostgres(providers.enabled(workspaceId)))?.id).toBe(first.id);
	});

	it("refuses to enable a provider without a key", async () => {
		const exit = await createExit({ settings: { preset: "e2b" }, enabled: true });

		expect(Exit.isFailure(exit) && exit.toString()).toContain("SandboxProviderIncomplete");
	});

	it("refuses to enable E2B Embed with only one of its addresses", async () => {
		const exit = await createExit({
			settings: { preset: "e2b", apiUrl: "http://localhost:3000" },
			enabled: true,
			apiKey: "key",
		});

		expect(Exit.isFailure(exit) && exit.toString()).toContain("SandboxProviderIncomplete");
	});

	it("refuses settings for another preset than the provider's", async () => {
		const provider = await create({ settings: { preset: "opensandbox" }, apiKey: "key" });

		const exit = await runOnPostgres(
			Effect.exit(providers.update(workspaceId, provider.id, { settings: { preset: "e2b" } })),
		);

		expect(Exit.isFailure(exit) && exit.toString()).toContain("SandboxProviderPresetFixed");
	});

	it("disables a provider whose key is removed", async () => {
		const provider = await create({
			settings: { preset: "opensandbox" },
			enabled: true,
			apiKey: "key",
		});

		const updated = await runOnPostgres(
			providers.update(workspaceId, provider.id, { apiKey: null }),
		);

		expect(updated?.enabled).toBe(false);
		expect(await runOnPostgres(providers.enabled(workspaceId))).toBeUndefined();
	});

	it("forgets its key when it is pointed at another address", async () => {
		const provider = await create({ settings: { preset: "e2b" }, enabled: true, apiKey: "key" });

		const updated = await runOnPostgres(
			providers.update(workspaceId, provider.id, {
				settings: {
					preset: "e2b",
					apiUrl: "https://e2b.example.com",
					sandboxUrl: "https://sandboxes.e2b.example.com",
				},
			}),
		);

		expect(updated && toSandboxProvider(updated).hasApiKey).toBe(false);
		expect(updated?.enabled).toBe(false);
	});

	it("forgets its template build once the template is another", async () => {
		const provider = await create({ settings: { preset: "e2b" }, apiKey: "key" });
		const build = { templateId: "template", buildId: "build" };
		const buildOf = async () =>
			(await runOnPostgres(providers.list(workspaceId))).find((row) => row.id === provider.id)
				?.managedResources?.templateBuild ?? null;

		await runOnPostgres(providers.recordTemplateBuild(workspaceId, provider.id, build));
		await runOnPostgres(providers.update(workspaceId, provider.id, { enabled: true }));
		expect(await buildOf()).toEqual(build);

		await runOnPostgres(
			providers.update(workspaceId, provider.id, {
				settings: { preset: "e2b", template: "another-template" },
			}),
		);
		expect(await buildOf()).toBeNull();
	});

	it("gives OpenSandbox its usual address, and the default image until another is set", async () => {
		const usualOpenSandbox = {
			preset: "opensandbox",
			serverUrl: "http://localhost:8090",
		} as const;
		const provider = await create({ settings: { preset: "opensandbox" }, apiKey: "key" });
		const imageOf = async () => {
			const configured = await runOnPostgres(providers.connection(workspaceId, provider.id));
			return configured?.connection.provider === "opensandbox"
				? configured.connection.image
				: undefined;
		};

		expect(toSandboxProvider(provider).settings).toEqual(usualOpenSandbox);
		expect(await imageOf()).toBe("ghcr.io/nitrictech/sugabots-sandbox:latest");

		await runOnPostgres(
			providers.update(workspaceId, provider.id, {
				settings: { ...usualOpenSandbox, image: "debian:trixie" },
			}),
		);
		expect(await imageOf()).toBe("debian:trixie");

		await runOnPostgres(providers.update(workspaceId, provider.id, { settings: usualOpenSandbox }));
		expect(await imageOf()).toBe("ghcr.io/nitrictech/sugabots-sandbox:latest");
	});
});
