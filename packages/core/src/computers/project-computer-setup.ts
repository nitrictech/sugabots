export * as ProjectComputerSetup from "./project-computer-setup.ts";

import type { ComputerDisk, ProjectComputer, ProjectComputerDisk } from "@sugabots/contracts";
import { computerProviderPreset } from "@sugabots/contracts";
import { userText } from "@sugabots/errors";
import { and, eq } from "drizzle-orm";
import { Context, Data, Effect, Layer } from "effect";
import type { AuthorizationDenied } from "../authorization/access.ts";
import { Authorization } from "../authorization/authorization.ts";
import type { CurrentActor } from "../authorization/current-actor.ts";
import { Visibility } from "../authorization/visibility.ts";
import { query, serviceOperations } from "../database/database.ts";
import { project as projectTable } from "../database/schema.ts";
import type { UserFacing } from "../user-message.ts";
import { ComputerProviderRepository } from "./computer-provider-repository.ts";
import type { Computers } from "./computers.ts";
import { ProjectComputers } from "./project-computers.ts";

/**
 * A project's computer for the people looking after the project, a bot's
 * being its default project's: how it stands for anyone in the project, and,
 * for those who may manage it, starting it afresh or moving its work to a
 * computer made from the current image.
 */
export interface Interface {
	readonly get: (
		projectId: string,
	) => Effect.Effect<ProjectComputer, AuthorizationDenied, CurrentActor.Service>;
	/**
	 * How full the disks of the computers of the workspace's projects the
	 * actor reaches are, bots' default projects included, of those measured.
	 */
	readonly disks: (
		workspace: string,
	) => Effect.Effect<ProjectComputerDisk[], AuthorizationDenied, CurrentActor.Service>;
	readonly reset: (
		projectId: string,
	) => Effect.Effect<
		ProjectComputer,
		AuthorizationDenied | ProjectComputers.ComputerInUse | Computers.Unavailable,
		CurrentActor.Service
	>;
	readonly upgrade: (
		projectId: string,
	) => Effect.Effect<
		ProjectComputer,
		| AuthorizationDenied
		| NoComputerProvider
		| ProjectComputers.ComputerInUse
		| ProjectComputers.NoComputer
		| ProjectComputers.UpgradeFailed
		| Computers.Unavailable,
		CurrentActor.Service
	>;
}

export class Service extends Context.Service<Service, Interface>()(
	"@sugabots/core/ProjectComputerSetup",
) {}

export const make = Effect.gen(function* () {
	const operation = yield* serviceOperations<Interface>("ProjectComputerSetup");
	const authorization = yield* Authorization.Service;
	const visibility = yield* Visibility.Service;
	const projectComputers = yield* ProjectComputers.Service;
	const providers = yield* ComputerProviderRepository.Service;

	const shown = (project: ProjectComputers.Project, canManage: boolean) =>
		Effect.gen(function* () {
			const current = yield* providers.enabled(project.workspaceId);
			const status = yield* projectComputers.status(project, current);
			const providerEnabled = current !== undefined;
			if (status.kind === "none")
				return { computer: status, providerEnabled, canManage } satisfies ProjectComputer;
			const row = (yield* providers.list(project.workspaceId)).find(
				(candidate) => candidate.id === status.providerId,
			);
			return {
				computer: {
					kind: "present",
					state: status.state,
					image: status.image ?? null,
					providerName: row ? computerProviderPreset(row.preset).name : "Removed provider",
					createdAt: status.createdAt.toISOString(),
					lastUsedAt: status.lastUsedAt.toISOString(),
					turnsUsing: status.turnsUsing,
					peopleWatching: status.peopleWatching,
					upgradeAvailable: status.upgradeAvailable,
					disk: status.disk ? shownDisk(status.disk) : null,
				},
				providerEnabled,
				canManage,
			} satisfies ProjectComputer;
		});

	const standingOn = (projectId: string, permission: "computer.read" | "computer.manage") =>
		Effect.map(authorization.project(projectId, permission), (standing) => ({
			project: { workspaceId: standing.project.workspaceId, projectId: standing.project.id },
			canManage: standing.may("computer.manage"),
		}));

	return Service.of({
		get: (projectId) =>
			operation(
				"get",
				Effect.flatMap(standingOn(projectId, "computer.read"), ({ project, canManage }) =>
					shown(project, canManage),
				),
			),

		disks: (workspace) =>
			operation(
				"disks",
				Effect.gen(function* () {
					const { workspaceId } = yield* authorization.workspace(workspace, "workspace.read");
					const reachesProject = yield* visibility.reachesProject;
					const seen = new Set(
						(yield* query((db) =>
							db
								.select({ id: projectTable.id })
								.from(projectTable)
								.where(
									and(eq(projectTable.workspaceId, workspaceId), reachesProject(projectTable.id)),
								),
						)).map(({ id }) => id),
					);
					const measured = yield* projectComputers.disksIn(workspaceId);
					return measured
						.filter(({ projectId }) => seen.has(projectId))
						.map(({ projectId, disk }) => ({ projectId, disk: shownDisk(disk) }));
				}),
			),

		reset: (projectId) =>
			operation(
				"reset",
				Effect.gen(function* () {
					const { project } = yield* standingOn(projectId, "computer.manage");
					yield* projectComputers.reset(project);
					return yield* shown(project, true);
				}),
			),

		upgrade: (projectId) =>
			operation(
				"upgrade",
				Effect.gen(function* () {
					const { project } = yield* standingOn(projectId, "computer.manage");
					const provider = yield* providers.enabled(project.workspaceId);
					if (!provider) return yield* new NoComputerProvider();
					yield* projectComputers.upgrade(project, provider);
					return yield* shown(project, true);
				}),
			),
	});
});

export const layerNoDeps = Layer.effect(Service, make);

export const layer = layerNoDeps.pipe(
	Layer.provide([
		Authorization.layer,
		Visibility.layer,
		ProjectComputers.layer,
		ComputerProviderRepository.layer,
	]),
);

function shownDisk(disk: ProjectComputers.MeasuredDisk): ComputerDisk {
	return { ...disk, measuredAt: disk.measuredAt.toISOString() };
}

/** No computer provider is enabled, so there's nothing to make a new computer with. */
export class NoComputerProvider
	extends Data.TaggedError("NoComputerProvider")
	implements UserFacing
{
	get userMessage() {
		return userText`Enable a computer provider in the workspace's settings first.`;
	}
}
