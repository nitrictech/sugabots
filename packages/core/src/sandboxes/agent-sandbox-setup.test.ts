import { Layer } from "effect";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
	agent,
	sandbox,
	sandboxProvider,
	user,
	workspace,
	workspaceMember,
} from "../database/schema.ts";
import { closeDatabase, onDatabase, type Promised } from "../database/testing.ts";
import { Egress } from "../providers/network/egress.ts";
import { unimplemented } from "../testing.ts";
import { servedOnPostgresAs } from "../workspaces/testing.ts";
import { AgentSandboxSetup } from "./agent-sandbox-setup.ts";
import { SandboxCredentials } from "./sandbox-credentials.ts";
import type { Sandboxes } from "./sandboxes.ts";

/**
 * Which bots' computers' disks a person is shown, against Postgres: the
 * scoping is SQL a fake can't check. Skips without a migrated database.
 */
describe.skipIf(!process.env.DATABASE_URL)("bots' computers' disks, against Postgres", () => {
	let setupAs: (userId: string) => Promised<AgentSandboxSetup.Interface>;

	beforeAll(async () => {
		setupAs = await servedOnPostgresAs(
			AgentSandboxSetup.Service,
			AgentSandboxSetup.layer.pipe(
				Layer.provide([
					unimplemented(SandboxCredentials.Service, {}),
					unimplemented(Egress.Service, {}),
				]),
			),
		);
	});

	afterAll(async () => {
		await closeDatabase();
	});

	it("leaves out the computers of another person's private bots, even for a workspace admin", async () => {
		const stamp = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
		const [space] = await onDatabase((db) =>
			db
				.insert(workspace)
				.values({ name: `Disks ${stamp}`, slug: `disks-${stamp}` })
				.returning(),
		);
		const [ada, sam] = await onDatabase((db) =>
			db
				.insert(user)
				.values([
					{ name: "Ada", email: `ada-disks-${stamp}@example.com` },
					{ name: "Sam", email: `sam-disks-${stamp}@example.com` },
				])
				.returning(),
		);
		if (!space || !ada || !sam) throw new Error("fixture");
		const workspaceId = space.id;
		await onDatabase((db) =>
			db.insert(workspaceMember).values([
				{ workspaceId, userId: ada.id, role: "admin" },
				{ workspaceId, userId: sam.id, role: "member" },
			]),
		);
		const [provider] = await onDatabase((db) =>
			db
				.insert(sandboxProvider)
				.values({
					workspaceId,
					settings: { preset: "opensandbox", serverUrl: "http://sandboxes.test", image: "debian" },
					enabled: true,
				})
				.returning(),
		);
		if (!provider) throw new Error("fixture");
		const bots = await onDatabase((db) =>
			db
				.insert(agent)
				.values(
					[
						{ visibility: "public" as const, createdById: ada.id },
						{ visibility: "private" as const, createdById: ada.id },
						{ visibility: "private" as const, createdById: sam.id },
					].map((placement, index) => ({
						...placement,
						workspaceId,
						name: `Bot ${index}`,
						handle: `bot-${index}`,
						color: "sky" as const,
						face: "pill" as const,
					})),
				)
				.returning(),
		);
		const [publicBot, adasBot, samsBot] = bots;
		if (!publicBot || !adasBot || !samsBot) throw new Error("fixture");
		await onDatabase((db) =>
			db.insert(sandbox).values(
				bots.map((measured) => ({
					workspaceId,
					agentId: measured.id,
					sandboxProviderId: provider.id,
					providerSandboxId: `sandbox-${measured.id}` as Sandboxes.SandboxId,
					diskUsage: { usedBytes: 1_000, totalBytes: 10_000, folders: [] },
					diskMeasuredAt: new Date(),
				})),
			),
		);

		const shown = await setupAs(sam.id).disks(workspaceId);
		const shownToAdmin = await setupAs(ada.id).disks(workspaceId);

		expect(shown.map(({ agentId }) => agentId).toSorted()).toEqual(
			[publicBot.id, samsBot.id].toSorted(),
		);
		expect(shownToAdmin.map(({ agentId }) => agentId).toSorted()).toEqual(
			[publicBot.id, adasBot.id].toSorted(),
		);
	});
});
