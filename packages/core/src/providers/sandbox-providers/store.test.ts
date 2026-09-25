import { DEFAULT_SANDBOX_ALLOWED_HOSTS } from "@sugabots/contracts";
import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { sandboxProvider, workspace } from "../../database/schema.ts";
import { closeDatabase, onDatabase, onPostgres, type Promised } from "../../database/testing.ts";
import { aesCredentialCipher } from "../model-providers/credentials.ts";
import { type SandboxProviderStore, sandboxProviderStore } from "./store.ts";

/**
 * The sandbox provider store against Postgres: one per workspace, filled in
 * from its preset, and what a turn is given to make sandboxes with.
 */
describe.skipIf(!process.env.DATABASE_URL)("sandbox providers, against Postgres", () => {
	const cipher = aesCredentialCipher(Buffer.alloc(32, 7).toString("base64"));
	const providers: Promised<SandboxProviderStore> = onPostgres(sandboxProviderStore(cipher));
	const userId = null as unknown as string;
	let workspaceId: string;

	afterAll(async () => {
		await closeDatabase();
	});

	beforeEach(async () => {
		const suffix = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
		const [space] = await onDatabase((db) =>
			db
				.insert(workspace)
				.values({ name: `Sandboxes ${suffix}`, slug: `sandbox-providers-${suffix}` })
				.returning(),
		);
		if (!space) throw new Error("fixture");
		workspaceId = space.id;
	});

	it("fills in what the preset supplies, and starts switched off without a key", async () => {
		const set = await providers.replace(workspaceId, userId, { preset: "opensandbox" });

		expect(set).toMatchObject({
			preset: "opensandbox",
			name: "OpenSandbox",
			baseUrl: "http://127.0.0.1:8090",
			image: "node:22-bookworm",
			isolation: "gvisor",
			allowedHosts: [...DEFAULT_SANDBOX_ALLOWED_HOSTS],
			enabled: false,
			hasApiKey: false,
			status: "missing_key",
		});
		expect(await providers.connection(workspaceId)).toBeUndefined();
	});

	it("gives a turn the connection only while enabled, with the key unsealed", async () => {
		await providers.replace(workspaceId, userId, { preset: "opensandbox", apiKey: "secret" });
		expect(await providers.resolve(workspaceId)).toBeUndefined();

		await providers.update(workspaceId, { enabled: true });
		expect(await providers.resolve(workspaceId)).toMatchObject({
			preset: "opensandbox",
			apiKey: "secret",
			allowedHosts: { kind: "only", hosts: [...DEFAULT_SANDBOX_ALLOWED_HOSTS] },
		});
		const [row] = await onDatabase((db) => db.select().from(sandboxProvider));
		expect(JSON.stringify(row)).not.toContain('"secret"');
	});

	it("reads a lone * as any host", async () => {
		await providers.replace(workspaceId, userId, {
			preset: "opensandbox",
			apiKey: "secret",
			enabled: true,
			allowedHosts: ["*"],
		});

		expect(await providers.resolve(workspaceId)).toMatchObject({ allowedHosts: { kind: "any" } });
	});

	it("forgets the last test when the address or key changes", async () => {
		const set = await providers.replace(workspaceId, userId, {
			preset: "opensandbox",
			apiKey: "secret",
		});
		const connection = await providers.connection(workspaceId);
		if (!connection) throw new Error("no connection");
		await providers.recordTest(workspaceId, connection.configurationUpdatedAt);
		expect((await providers.get(workspaceId))?.status).toBe("connected");

		await providers.update(workspaceId, { baseUrl: "http://127.0.0.1:9090" });
		expect((await providers.get(workspaceId))?.status).toBe("untested");
		expect(set.id).toBe((await providers.get(workspaceId))?.id);
	});
});
