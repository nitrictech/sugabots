export * as AgentSandboxSetup from "./agent-sandbox-setup.ts";

import type { AgentSandbox, AgentSandboxDisk, SandboxDisk } from "@sugabots/contracts";
import { sandboxProviderPreset } from "@sugabots/contracts";
import { userText } from "@sugabots/errors";
import { and, eq } from "drizzle-orm";
import { Context, Data, Effect, Layer } from "effect";
import type { AuthorizationDenied } from "../authorization/access.ts";
import { Authorization } from "../authorization/authorization.ts";
import type { CurrentActor } from "../authorization/current-actor.ts";
import { Visibility } from "../authorization/visibility.ts";
import { query, serviceOperations } from "../database/database.ts";
import { agent as agentTable } from "../database/schema.ts";
import type { UserFacing } from "../user-message.ts";
import { AgentSandboxes } from "./agent-sandboxes.ts";
import { SandboxProviderRepository } from "./sandbox-provider-repository.ts";
import type { Sandboxes } from "./sandboxes.ts";

/**
 * A bot's computer for the people looking after the bot: how it stands for
 * anyone who can see the bot, and, for those who may manage it, starting it
 * afresh or moving its work to a computer made from the current image.
 */
export interface Interface {
	readonly get: (
		agentId: string,
	) => Effect.Effect<AgentSandbox, AuthorizationDenied, CurrentActor.Service>;
	/** How full the disks of the computers of the workspace's bots the actor sees are, of those measured. */
	readonly disks: (
		workspace: string,
	) => Effect.Effect<AgentSandboxDisk[], AuthorizationDenied, CurrentActor.Service>;
	readonly reset: (
		agentId: string,
	) => Effect.Effect<
		AgentSandbox,
		AuthorizationDenied | AgentSandboxes.SandboxInUse | Sandboxes.Unavailable,
		CurrentActor.Service
	>;
	readonly upgrade: (
		agentId: string,
	) => Effect.Effect<
		AgentSandbox,
		| AuthorizationDenied
		| NoSandboxProvider
		| AgentSandboxes.SandboxInUse
		| AgentSandboxes.NoSandbox
		| AgentSandboxes.UpgradeFailed
		| Sandboxes.Unavailable,
		CurrentActor.Service
	>;
}

export class Service extends Context.Service<Service, Interface>()(
	"@sugabots/core/AgentSandboxSetup",
) {}

export const make = Effect.gen(function* () {
	const operation = yield* serviceOperations<Interface>("AgentSandboxSetup");
	const authorization = yield* Authorization.Service;
	const visibility = yield* Visibility.Service;
	const agentSandboxes = yield* AgentSandboxes.Service;
	const providers = yield* SandboxProviderRepository.Service;

	const shown = (agent: AgentSandboxes.Agent, canManage: boolean) =>
		Effect.gen(function* () {
			const current = yield* providers.enabled(agent.workspaceId);
			const status = yield* agentSandboxes.status(agent, current);
			const providerEnabled = current !== undefined;
			if (status.kind === "none")
				return { sandbox: status, providerEnabled, canManage } satisfies AgentSandbox;
			const row = (yield* providers.list(agent.workspaceId)).find(
				(candidate) => candidate.id === status.providerId,
			);
			return {
				sandbox: {
					kind: "present",
					state: status.state,
					image: status.image ?? null,
					providerName: row ? sandboxProviderPreset(row.preset).name : "Removed provider",
					createdAt: status.createdAt.toISOString(),
					lastUsedAt: status.lastUsedAt.toISOString(),
					turnsUsing: status.turnsUsing,
					peopleWatching: status.peopleWatching,
					upgradeAvailable: status.upgradeAvailable,
					disk: status.disk ? shownDisk(status.disk) : null,
				},
				providerEnabled,
				canManage,
			} satisfies AgentSandbox;
		});

	const standingOn = (agentId: string, permission: "agent.settings.read" | "sandbox.manage") =>
		Effect.map(authorization.agent(agentId, permission), (standing) => ({
			agent: { workspaceId: standing.agent.workspaceId, agentId: standing.agent.id },
			canManage: standing.may("sandbox.manage"),
		}));

	return Service.of({
		get: (agentId) =>
			operation(
				"get",
				Effect.flatMap(standingOn(agentId, "agent.settings.read"), ({ agent, canManage }) =>
					shown(agent, canManage),
				),
			),

		disks: (workspace) =>
			operation(
				"disks",
				Effect.gen(function* () {
					const { workspaceId } = yield* authorization.workspace(workspace, "workspace.read");
					const reachesAgent = yield* visibility.reachesAgent;
					const seen = new Set(
						(yield* query((db) =>
							db
								.select({ id: agentTable.id })
								.from(agentTable)
								.where(and(eq(agentTable.workspaceId, workspaceId), reachesAgent(agentTable.id))),
						)).map(({ id }) => id),
					);
					const measured = yield* agentSandboxes.disksIn(workspaceId);
					return measured
						.filter(({ agentId }) => seen.has(agentId))
						.map(({ agentId, disk }) => ({ agentId, disk: shownDisk(disk) }));
				}),
			),

		reset: (agentId) =>
			operation(
				"reset",
				Effect.gen(function* () {
					const { agent } = yield* standingOn(agentId, "sandbox.manage");
					yield* agentSandboxes.reset(agent);
					return yield* shown(agent, true);
				}),
			),

		upgrade: (agentId) =>
			operation(
				"upgrade",
				Effect.gen(function* () {
					const { agent } = yield* standingOn(agentId, "sandbox.manage");
					const provider = yield* providers.enabled(agent.workspaceId);
					if (!provider) return yield* new NoSandboxProvider();
					yield* agentSandboxes.upgrade(agent, provider);
					return yield* shown(agent, true);
				}),
			),
	});
});

export const layerNoDeps = Layer.effect(Service, make);

export const layer = layerNoDeps.pipe(
	Layer.provide([
		Authorization.layer,
		Visibility.layer,
		AgentSandboxes.layer,
		SandboxProviderRepository.layer,
	]),
);

function shownDisk(disk: AgentSandboxes.MeasuredDisk): SandboxDisk {
	return { ...disk, measuredAt: disk.measuredAt.toISOString() };
}

/** No computer provider is enabled, so there's nothing to make a new computer with. */
export class NoSandboxProvider extends Data.TaggedError("NoSandboxProvider") implements UserFacing {
	get userMessage() {
		return userText`Enable a computer provider in the workspace's settings first.`;
	}
}
