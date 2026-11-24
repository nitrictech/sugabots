export * as ProjectComputerSetup from "./project-computer-setup.ts";

import type { ComputerDisk, ProjectComputer, ProjectComputerDisk } from "@sugabots/contracts";
import { computerBuiltInProvider } from "@sugabots/contracts";
import {
	type ComputerInUse,
	type ComputerUnavailable,
	type NoComputer,
	NoComputerProvider,
	type UpgradeFailed,
} from "@sugabots/contracts/errors/computers";
import { and, eq } from "drizzle-orm";
import { Context, Effect, Layer } from "effect";
import { query, serviceOperations } from "../database/database.ts";
import { project as projectTable } from "../database/schema.ts";
import type { CanManageProject } from "../proofs/project-permissions.ts";
import type { ReachSet } from "../proofs/reach-set.ts";
import type { ReachesProject } from "../proofs/reaches-project.ts";
import { processLayer, Tier } from "../tiers.ts";
import { ComputerProviderStore } from "./computer-provider-store.ts";
import { ProjectComputers } from "./project-computers.ts";

/**
 * A project's computer for the members looking after the project, a bot's
 * being its default project's, for operations that have proved what each call
 * needs: how it stands for whoever reaches the project, and, for those who
 * manage it, starting it afresh or moving its work to a computer made from
 * the current image. Each method takes the project from its proof.
 */
export interface Interface {
	readonly get: <P, J>(reach: ReachesProject<P, J>) => Effect.Effect<ProjectComputer>;
	/**
	 * How full the disks of the computers of the workspace's projects the
	 * principal reaches are, bots' default projects included, of those measured.
	 */
	readonly disks: <P, W>(reachSet: ReachSet<P, W>) => Effect.Effect<ProjectComputerDisk[]>;
	readonly reset: <P, J>(
		canManage: CanManageProject<P, J>,
	) => Effect.Effect<ProjectComputer, ComputerInUse | ComputerUnavailable>;
	readonly upgrade: <P, J>(
		canManage: CanManageProject<P, J>,
	) => Effect.Effect<
		ProjectComputer,
		NoComputerProvider | ComputerInUse | NoComputer | UpgradeFailed | ComputerUnavailable
	>;
}

export class Service extends Context.Service<Service, Interface>()(
	"@sugabots/core/ProjectComputerSetup",
) {
	declare readonly [Tier]: "process";
}

export const make = Effect.gen(function* () {
	const operation = yield* serviceOperations<Interface>("ProjectComputerSetup");
	const projectComputers = yield* ProjectComputers.Service;
	const providers = yield* ComputerProviderStore.Service;

	const shown = (project: ProjectComputers.Project) =>
		Effect.gen(function* () {
			const current = yield* providers.enabled(project.workspaceId);
			const status = yield* projectComputers.status(project, current);
			const providerEnabled = current !== undefined;
			if (status.kind === "none")
				return { computer: status, providerEnabled } satisfies ProjectComputer;
			const row = (yield* providers.list(project.workspaceId)).find(
				(candidate) => candidate.id === status.providerId,
			);
			return {
				computer: {
					kind: "present",
					state: status.state,
					image: status.image ?? null,
					providerName: row ? computerBuiltInProvider(row.builtIn).name : "Removed provider",
					createdAt: status.createdAt.toISOString(),
					lastUsedAt: status.lastUsedAt.toISOString(),
					turnsUsing: status.turnsUsing,
					membersWatching: status.membersWatching,
					upgradeAvailable: status.upgradeAvailable,
					disk: status.disk ? shownDisk(status.disk) : null,
				},
				providerEnabled,
			} satisfies ProjectComputer;
		});

	/** The project a proof that reaches it names. */
	const projectOf = <P, J>(reach: ReachesProject<P, J>): ProjectComputers.Project => ({
		workspaceId: reach.workspace,
		projectId: reach.project.value,
	});

	return Service.of({
		get: (reach) => operation("get", shown(projectOf(reach))),

		disks: (reachSet) =>
			operation(
				"disks",
				Effect.gen(function* () {
					const workspaceId = reachSet.workspace.value;
					const seen = new Set(
						(yield* query((db) =>
							db
								.select({ id: projectTable.id })
								.from(projectTable)
								.where(
									and(
										eq(projectTable.workspaceId, workspaceId),
										reachSet.reachesProject(projectTable.id),
									),
								),
						)).map(({ id }) => id),
					);
					const measured = yield* projectComputers.disksIn(workspaceId);
					return measured
						.filter(({ projectId }) => seen.has(projectId))
						.map(({ projectId, disk }) => ({ projectId, disk: shownDisk(disk) }));
				}),
			),

		reset: (canManage) =>
			operation(
				"reset",
				Effect.gen(function* () {
					const project = projectOf(canManage.reach);
					yield* projectComputers.reset(project);
					return yield* shown(project);
				}),
			),

		upgrade: (canManage) =>
			operation(
				"upgrade",
				Effect.gen(function* () {
					const project = projectOf(canManage.reach);
					const provider = yield* providers.enabled(project.workspaceId);
					if (!provider) return yield* new NoComputerProvider();
					yield* projectComputers.upgrade(project, provider);
					return yield* shown(project);
				}),
			),
	});
});

export const layerNoDeps = processLayer(Layer.effect(Service, make));

export const layer = layerNoDeps.pipe(
	Layer.provide([ProjectComputers.layer, ComputerProviderStore.layer]),
);

function shownDisk(disk: ProjectComputers.MeasuredDisk): ComputerDisk {
	return { ...disk, measuredAt: disk.measuredAt.toISOString() };
}
