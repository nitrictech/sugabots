import { eq } from "drizzle-orm";
import { Layer } from "effect";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
	computer,
	computerProvider,
	project,
	user,
	workspace,
	workspaceMember,
} from "../database/schema.ts";
import {
	closeDatabase,
	onDatabase,
	type Promised,
	waitUntilWaitingOnLocks,
} from "../database/testing.ts";
import { servedOnPostgresAs } from "../workspaces/testing.ts";
import { ComputerProviderSetup } from "./computer-provider-setup.ts";
import { ProjectComputers } from "./project-computers.ts";
import { noComputers, recordingFirstComputer } from "./testing.ts";

/** Removing a computer provider, against Postgres. Skips without a database. */
describe.skipIf(!process.env.DATABASE_URL)("removing a computer provider, against Postgres", () => {
	let setupAs: (userId: string) => Promised<ComputerProviderSetup.Interface>;

	beforeAll(async () => {
		setupAs = await servedOnPostgresAs(
			ComputerProviderSetup.Service,
			ComputerProviderSetup.layer.pipe(Layer.provide(noComputers)),
		);
	});

	afterAll(closeDatabase);

	it("keeps a provider that makes a project's first computer while it is removed", async () => {
		const suffix = crypto.randomUUID().slice(0, 8);
		const [space] = await onDatabase((db) =>
			db
				.insert(workspace)
				.values({ name: `Providers ${suffix}`, slug: `providers-${suffix}` })
				.returning(),
		);
		const [owner] = await onDatabase((db) =>
			db
				.insert(user)
				.values({ name: "Ada", email: `providers-${suffix}@example.com` })
				.returning(),
		);
		if (!space || !owner) throw new Error("fixture");
		await onDatabase((db) =>
			db.insert(workspaceMember).values({ workspaceId: space.id, userId: owner.id, role: "owner" }),
		);
		const [launch] = await onDatabase((db) =>
			db
				.insert(project)
				.values({ workspaceId: space.id, name: "Launch", slug: "launch" })
				.returning(),
		);
		const [provider] = await onDatabase((db) =>
			db
				.insert(computerProvider)
				.values({
					workspaceId: space.id,
					settings: { preset: "opensandbox", serverUrl: "http://computers.test", image: "debian" },
					enabled: true,
				})
				.returning(),
		);
		if (!launch || !provider) throw new Error("fixture");
		const recording = await recordingFirstComputer({
			workspaceId: space.id,
			projectId: launch.id,
			computerProviderId: provider.id,
		});

		const removing = setupAs(owner.id).remove({ workspace: space.id, providerId: provider.id });
		await waitUntilWaitingOnLocks(1);
		await recording.release();

		await expect(removing).rejects.toBeInstanceOf(ProjectComputers.ComputerMadeMeanwhile);
		expect(
			await onDatabase((db) =>
				db
					.select({ id: computer.id })
					.from(computer)
					.innerJoin(computerProvider, eq(computerProvider.id, computer.computerProviderId))
					.where(eq(computer.computerProviderId, provider.id)),
			),
		).toHaveLength(1);
	});
});
