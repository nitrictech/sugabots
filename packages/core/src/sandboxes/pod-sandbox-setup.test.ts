import { Layer } from "effect";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
	pod,
	podMember,
	sandbox,
	sandboxProvider,
	user,
	workspace,
	workspaceMember,
} from "../database/schema.ts";
import { closeDatabase, onDatabase, type Promised } from "../database/testing.ts";
import { unimplemented } from "../testing.ts";
import { servedOnPostgresAs } from "../workspaces/testing.ts";
import { PodSandboxSetup } from "./pod-sandbox-setup.ts";
import { SandboxCredentials } from "./sandbox-credentials.ts";
import type { Sandboxes } from "./sandboxes.ts";

/**
 * Which pods' disks a person is shown, against Postgres: the scoping is SQL
 * a fake can't check. Skips without a migrated database.
 */
describe.skipIf(!process.env.DATABASE_URL)("pod sandboxes' disks, against Postgres", () => {
	let setupAs: (userId: string) => Promised<PodSandboxSetup.Interface>;

	beforeAll(async () => {
		setupAs = await servedOnPostgresAs(
			PodSandboxSetup.Service,
			PodSandboxSetup.layer.pipe(Layer.provide(unimplemented(SandboxCredentials.Service, {}))),
		);
	});

	afterAll(async () => {
		await closeDatabase();
	});

	it("leaves out another person's Personal pod, even for a workspace admin", async () => {
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
		const [shared, adasOwn, samsOwn] = await onDatabase((db) =>
			db
				.insert(pod)
				.values([
					{ workspaceId, kind: "shared", name: "Builders", slug: `builders-${stamp}` },
					{ workspaceId, kind: "personal", ownerId: ada.id, name: "Personal", slug: "personal" },
					{ workspaceId, kind: "personal", ownerId: sam.id, name: "Personal", slug: "personal" },
				])
				.returning(),
		);
		if (!shared || !adasOwn || !samsOwn) throw new Error("fixture");
		// Admins join every shared pod as it's made; members are added.
		await onDatabase((db) =>
			db.insert(podMember).values({ workspaceId, podId: shared.id, userId: sam.id }),
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
		await onDatabase((db) =>
			db.insert(sandbox).values(
				[shared, adasOwn, samsOwn].map((measured) => ({
					workspaceId,
					podId: measured.id,
					sandboxProviderId: provider.id,
					providerSandboxId: `sandbox-${measured.id}` as Sandboxes.SandboxId,
					diskUsage: { usedBytes: 1_000, totalBytes: 10_000, folders: [] },
					diskMeasuredAt: new Date(),
				})),
			),
		);

		const shown = await setupAs(sam.id).disks(workspaceId);
		const shownToAdmin = await setupAs(ada.id).disks(workspaceId);

		expect(shown.map(({ podId }) => podId).toSorted()).toEqual([shared.id, samsOwn.id].toSorted());
		expect(shownToAdmin.map(({ podId }) => podId).toSorted()).toEqual(
			[shared.id, adasOwn.id].toSorted(),
		);
	});
});
