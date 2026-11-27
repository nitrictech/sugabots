import { Effect, Layer } from "effect";
import { afterAll, expect, it } from "vitest";
import {
	seedBot,
	seedMember,
	seedProject,
	seedWorkspace,
} from "../authentication/seed.test-support.ts";
import { EventOutbox } from "../database/events/outbox.ts";
import { computerProvider } from "../database/schema.ts";
import { closeDatabase, onDatabase, runOnPostgres } from "../database/testing.ts";
import { proveInWorkspace } from "../proofs/in-workspace.ts";
import { named } from "../proofs/proof.ts";
import { proveReachesComputerProvider } from "../proofs/reaches-computer-provider.ts";
import { proveCanManageWorkspace } from "../proofs/workspace-permissions.ts";
import { authenticators, principals } from "../proofs/world.test-support.ts";
import { Egress } from "../providers/network/egress.ts";
import { unimplemented } from "../testing.ts";
import { ComputerProviderSetup } from "./computer-provider-setup.ts";
import { noComputers, recordingFirstComputer } from "./testing.ts";

afterAll(closeDatabase);

it("keeps a provider that makes a project's first computer while it is removed", async () => {
	const workspaceId = await seedWorkspace();
	const owner = await seedMember(workspaceId, "owner");
	const lead = await seedBot(workspaceId, { createdById: owner });
	const projectId = await seedProject(workspaceId, { leadBotId: lead.id });
	const [provider] = await onDatabase((db) =>
		db
			.insert(computerProvider)
			.values({
				workspaceId,
				settings: { builtIn: "opensandbox", serverUrl: "http://computers.test" },
				enabled: true,
			})
			.returning({ id: computerProvider.id }),
	);
	if (!provider) throw new Error("Expected a computer provider");
	const principal = await principals(await authenticators()).member(owner);
	const setup = await runOnPostgres(
		Effect.provide(
			ComputerProviderSetup.Service,
			ComputerProviderSetup.layer.pipe(
				Layer.provide([
					noComputers,
					unimplemented(Egress.Service),
					unimplemented(EventOutbox.Service),
				]),
			),
		),
	);
	const recording = await recordingFirstComputer({
		workspaceId,
		projectId,
		computerProviderId: provider.id,
	});

	const removing = runOnPostgres(
		named(principal, workspaceId, provider.id, (principal, workspace, provider) =>
			Effect.gen(function* () {
				const canManage = yield* proveCanManageWorkspace(
					yield* proveInWorkspace(principal, workspace),
				);
				const target = yield* proveReachesComputerProvider(canManage, provider);
				yield* setup.remove(canManage, provider, target);
			}),
		),
	);
	const refused = expect(removing).rejects.toMatchObject({ _tag: "ComputerMadeMeanwhile" });
	await recording.waitForWaiters(1);
	await recording.release();
	await refused;

	const listed = await runOnPostgres(
		named(principal, workspaceId, (principal, workspace) =>
			proveInWorkspace(principal, workspace).pipe(
				Effect.flatMap(proveCanManageWorkspace),
				Effect.flatMap(setup.list),
			),
		),
	);
	expect(listed).toContainEqual(expect.objectContaining({ id: provider.id }));
});
