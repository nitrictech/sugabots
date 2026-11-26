import type { NewComputerProvider } from "@sugabots/contracts";
import { Effect, Exit, Redacted } from "effect";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { computerDestruction } from "../database/schema.ts";
import { closeDatabase, onDatabase, runOnPostgres } from "../database/testing.ts";
import { createTestMember, createTestWorkspace } from "../database/workspace.test-support.ts";
import { toComputerProvider } from "./computer-provider-reads.ts";
import { ComputerProviderStore } from "./computer-provider-store.ts";
import { Computers } from "./computers.ts";

/**
 * A workspace's computer providers against Postgres: as many as it likes, at
 * most one enabled, and never one enabled without what it needs.
 */
describe.skipIf(!process.env.DATABASE_URL)("computer providers, against Postgres", () => {
	let providers: ComputerProviderStore.Interface;
	let workspaceId: string;
	let createdById: string;

	beforeAll(async () => {
		providers = await runOnPostgres(
			Effect.provide(ComputerProviderStore.Service, ComputerProviderStore.layer),
		);
	});

	afterAll(async () => {
		await closeDatabase();
	});

	beforeEach(async () => {
		const suffix = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
		const space = await createTestWorkspace({
			name: `Providers ${suffix}`,
			slug: `providers-${suffix}`,
		});
		const somebody = await createTestMember({
			name: "Sam",
			email: `providers-${suffix}@example.com`,
		});
		workspaceId = space.id;
		createdById = somebody.id;
	});

	const create = (provider: NewComputerProvider) =>
		runOnPostgres(providers.create(workspaceId, { createdById, provider }));
	const createExit = (provider: NewComputerProvider) =>
		runOnPostgres(Effect.exit(providers.create(workspaceId, { createdById, provider })));
	const enabledIds = async () =>
		(await runOnPostgres(providers.list(workspaceId)))
			.filter((row) => row.enabled)
			.map((row) => row.id);

	it("keeps one provider enabled, the one enabled last", async () => {
		const first = await create({
			settings: { builtIn: "opensandbox" },
			enabled: true,
			apiKey: "one",
		});
		const second = await create({ settings: { builtIn: "e2b" }, enabled: true, apiKey: "two" });

		expect(await enabledIds()).toEqual([second.id]);

		await runOnPostgres(providers.update(workspaceId, first.id, { enabled: true }));

		expect(await enabledIds()).toEqual([first.id]);
		expect((await runOnPostgres(providers.enabled(workspaceId)))?.id).toBe(first.id);
	});

	it("refuses to enable a provider without a key", async () => {
		const exit = await createExit({ settings: { builtIn: "e2b" }, enabled: true });

		expect(Exit.isFailure(exit) && exit.toString()).toContain("ComputerProviderIncomplete");
	});

	it("refuses to enable E2B Embed with only one of its addresses", async () => {
		const exit = await createExit({
			settings: { builtIn: "e2b", apiUrl: "http://localhost:3000" },
			enabled: true,
			apiKey: "key",
		});

		expect(Exit.isFailure(exit) && exit.toString()).toContain("ComputerProviderIncomplete");
	});

	it("refuses settings for another built-in provider than the provider's", async () => {
		const provider = await create({ settings: { builtIn: "opensandbox" }, apiKey: "key" });

		const exit = await runOnPostgres(
			Effect.exit(providers.update(workspaceId, provider.id, { settings: { builtIn: "e2b" } })),
		);

		expect(Exit.isFailure(exit) && exit.toString()).toContain("ComputerProviderBuiltInFixed");
	});

	it("disables a provider whose key is removed", async () => {
		const provider = await create({
			settings: { builtIn: "opensandbox" },
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
		const provider = await create({ settings: { builtIn: "e2b" }, enabled: true, apiKey: "key" });

		const updated = await runOnPostgres(
			providers.update(workspaceId, provider.id, {
				settings: {
					builtIn: "e2b",
					apiUrl: "https://e2b.example.com",
					sandboxUrl: "https://computers.e2b.example.com",
				},
			}),
		);

		expect(updated && toComputerProvider(updated).hasApiKey).toBe(false);
		expect(updated?.enabled).toBe(false);
	});

	it("keeps the key and address of a provider with a machine still to destroy, and takes a new key", async () => {
		const provider = await create({ settings: { builtIn: "e2b" }, enabled: true, apiKey: "key" });
		await onDatabase((db) =>
			db.insert(computerDestruction).values({
				workspaceId,
				computerProviderId: provider.id,
				providerComputerId: Computers.ComputerId("left-behind"),
			}),
		);
		const refusal = (changes: Parameters<ComputerProviderStore.Interface["update"]>[2]) =>
			runOnPostgres(Effect.flip(providers.update(workspaceId, provider.id, changes)));

		const keyTaken = await refusal({ apiKey: null });
		const moved = await refusal({
			settings: {
				builtIn: "e2b",
				apiUrl: "https://e2b.example.com",
				sandboxUrl: "https://computers.e2b.example.com",
			},
		});
		const replacementKey = "another key";
		const rotated = await runOnPostgres(
			providers.update(workspaceId, provider.id, { apiKey: replacementKey }),
		);

		for (const refused of [keyTaken, moved]) {
			expect(refused).toBeInstanceOf(ComputerProviderStore.ComputerProviderHasComputers);
			expect(
				String((refused as ComputerProviderStore.ComputerProviderHasComputers).userMessage),
			).toBe(
				"This provider still has computers, which need its key and address to be removed. Reset its projects' computers, or remove the provider, before taking either away.",
			);
		}
		expect(rotated?.enabled).toBe(true);
		const configured = await runOnPostgres(providers.access(workspaceId, provider.id));
		expect(configured && Redacted.value(configured.access.apiKey)).toBe(replacementKey);
	});

	it("forgets its template build once the template is another", async () => {
		const provider = await create({ settings: { builtIn: "e2b" }, apiKey: "key" });
		const build = { templateId: "template", buildId: "build" };
		const buildOf = async () =>
			(await runOnPostgres(providers.list(workspaceId))).find((row) => row.id === provider.id)
				?.managedResources?.templateBuild ?? null;

		await runOnPostgres(providers.recordTemplateBuild(workspaceId, provider.id, build));
		await runOnPostgres(providers.update(workspaceId, provider.id, { enabled: true }));
		expect(await buildOf()).toEqual(build);

		await runOnPostgres(
			providers.update(workspaceId, provider.id, {
				settings: { builtIn: "e2b", template: "another-template" },
			}),
		);
		expect(await buildOf()).toBeNull();
	});

	it("gives OpenSandbox its usual address, and the default image until another is set", async () => {
		const usualOpenSandbox = {
			builtIn: "opensandbox",
			serverUrl: "http://localhost:8090",
		} as const;
		const provider = await create({ settings: { builtIn: "opensandbox" }, apiKey: "key" });
		const imageOf = async () => {
			const configured = await runOnPostgres(providers.access(workspaceId, provider.id));
			return configured?.access.provider === "opensandbox" ? configured.access.image : undefined;
		};

		expect(toComputerProvider(provider).settings).toEqual(usualOpenSandbox);
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
