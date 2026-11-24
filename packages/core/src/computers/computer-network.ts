/** The host is blocked for the workspace, so no project may allow it. */
export { ComputerHostBlocked as HostBlocked } from "@sugabots/contracts/errors/computers";
export * as ComputerNetwork from "./computer-network.ts";

import {
	COMPUTER_NETWORK_MODE_DEFAULT,
	type ComputerNetworkSettings,
	type ProjectComputerNetwork,
} from "@sugabots/contracts";
import { ComputerHostBlocked } from "@sugabots/contracts/errors/computers";
import { and, eq } from "drizzle-orm";
import { Context, Effect, Layer } from "effect";
import { type Database, query, serviceOperations } from "../database/database.ts";
import {
	allowedHost,
	blockedHost,
	placedChat,
	projectAllowedHost,
	toolCall,
	turn,
} from "../database/schema.ts";
import type { CanChangeAllowedHosts } from "../proofs/project-permissions.ts";
import type { ReachesProject } from "../proofs/reaches-project.ts";
import type { CanManageWorkspace } from "../proofs/workspace-permissions.ts";
import { processLayer, Tier } from "../tiers.ts";
import { memberNamesOf } from "../workspaces/membership/member-reads.ts";
import {
	addedHostsOf,
	blockedHostsOf,
	blockOn,
	projectAddedHostsOf,
	TRUSTED_HOSTS,
} from "./allowed-hosts.ts";
import { ComputerProviderStore } from "./computer-provider-store.ts";
import { Computers } from "./computers.ts";
import { ProjectComputers } from "./project-computers.ts";

/**
 * Where computers may connect to. Every project's computer reaches
 * {@link TRUSTED_HOSTS} and the hosts its workspace added, and each project
 * adds its own, a bot's being its default project's; the workspace's blocks keep hosts out of every computer's reach,
 * whatever allows them. A change reaches running computers at once, and the
 * others when they are next opened.
 *
 * Each method but `grantRequest` is for an operation that has proved what it
 * needs, and takes the workspace or the project from its proof: the
 * workspace's lists to those who may manage the workspace, a project's own
 * list to whoever reaches it to see, and to its managers to change.
 */
export interface Interface {
	readonly settings: <P, W>(
		canManage: CanManageWorkspace<P, W>,
	) => Effect.Effect<ComputerNetworkSettings>;
	readonly addHost: <P, W>(
		canManage: CanManageWorkspace<P, W>,
		host: string,
	) => Effect.Effect<ComputerNetworkSettings>;
	/** Removing a host the workspace never added changes nothing. */
	readonly removeHost: <P, W>(
		canManage: CanManageWorkspace<P, W>,
		host: string,
	) => Effect.Effect<ComputerNetworkSettings>;
	readonly blockHost: <P, W>(
		canManage: CanManageWorkspace<P, W>,
		host: string,
	) => Effect.Effect<ComputerNetworkSettings>;
	/** Unblocking a host the workspace never blocked changes nothing. */
	readonly unblockHost: <P, W>(
		canManage: CanManageWorkspace<P, W>,
		host: string,
	) => Effect.Effect<ComputerNetworkSettings>;
	readonly projectSettings: <P, J>(
		reach: ReachesProject<P, J>,
	) => Effect.Effect<ProjectComputerNetwork>;
	/** Adding a host the workspace blocked fails with {@link ComputerHostBlocked}. */
	readonly addProjectHost: <P, J>(
		canChange: CanChangeAllowedHosts<P, J>,
		host: string,
	) => Effect.Effect<ProjectComputerNetwork, ComputerHostBlocked>;
	/** Removing a host the project never added changes nothing. */
	readonly removeProjectHost: <P, J>(
		canChange: CanChangeAllowedHosts<P, J>,
		host: string,
	) => Effect.Effect<ProjectComputerNetwork>;
	/**
	 * Adds `host` to the project whose computer the turn worked on whose call
	 * `sdkToolCallId` asked for it, if a member allowed that call and the
	 * workspace hasn't blocked the host since.
	 *
	 * Takes no proof: it exists only because the `request_host` tool still
	 * calls this service directly, and goes when tools become operations.
	 */
	readonly grantRequest: (input: {
		turnId: string;
		sdkToolCallId: string;
		host: string;
	}) => Effect.Effect<Grant>;
}

/** What became of an allowed request: added, refused by a block, or never allowed. */
type Grant = { kind: "added" } | { kind: "blocked"; by: string } | { kind: "not-allowed" };

export class Service extends Context.Service<Service, Interface>()(
	"@sugabots/core/ComputerNetwork",
) {
	declare readonly [Tier]: "process";
}

export const make = Effect.gen(function* () {
	const operation = yield* serviceOperations<Interface>("ComputerNetwork");
	const projectComputers = yield* ProjectComputers.Service;
	const providers = yield* ComputerProviderStore.Service;
	const computers = yield* Computers.Service;

	/**
	 * How the workspace's computers reach the internet, by its enabled
	 * provider, and whether its blocks keep hosts out.
	 */
	const networkOf = (workspaceId: string) =>
		Effect.map(providers.enabled(workspaceId), (enabled) => {
			if (!enabled) return { mode: COMPUTER_NETWORK_MODE_DEFAULT, blocking: true };
			const { networkMode, capabilities } = computers.forAccess(enabled.access);
			return {
				mode: networkMode,
				blocking: networkMode === "allowed-hosts-only" || capabilities.blocksHosts,
			};
		});

	const settingsOf = (workspaceId: string) =>
		Effect.gen(function* () {
			const [network, added, blocked] = yield* Effect.all([
				networkOf(workspaceId),
				addedHostsOf(workspaceId),
				blockedHostsOf(workspaceId),
			]);
			const names = yield* memberNamesOf([
				...added.map((row) => row.addedById),
				...blocked.map((row) => row.blockedById),
			]);
			return {
				...network,
				trustedHosts: TRUSTED_HOSTS,
				addedHosts: added.map((row) => ({
					host: row.host,
					addedByName: nameOf(names, row.addedById),
				})),
				blockedHosts: blocked.map((row) => ({
					host: row.host,
					blockedByName: nameOf(names, row.blockedById),
				})),
			} satisfies ComputerNetworkSettings;
		});

	const projectSettingsOf = (project: Project) =>
		Effect.gen(function* () {
			const [network, workspaceAdded, projectAdded, blocked] = yield* Effect.all([
				networkOf(project.workspaceId),
				addedHostsOf(project.workspaceId),
				projectAddedHostsOf(project),
				blockedHostsOf(project.workspaceId),
			]);
			const blocks = blocked.map((row) => row.host);
			const names = yield* memberNamesOf(projectAdded.map((row) => row.addedById));
			return {
				...network,
				workspaceHosts: [...TRUSTED_HOSTS, ...workspaceAdded.map((row) => row.host)].map(
					(host) => ({ host, blockedBy: blockOn(host, blocks) ?? null }),
				),
				addedHosts: projectAdded.map((row) => ({
					host: row.host,
					addedByName: nameOf(names, row.addedById),
					blockedBy: blockOn(row.host, blocks) ?? null,
				})),
			} satisfies ProjectComputerNetwork;
		});

	const blockFor = (workspaceId: string, host: string) =>
		Effect.map(blockedHostsOf(workspaceId), (blocked) =>
			blockOn(
				host,
				blocked.map((row) => row.host),
			),
		);

	const addToProject = (row: typeof projectAllowedHost.$inferInsert) =>
		query((db) => db.insert(projectAllowedHost).values(row).onConflictDoNothing()).pipe(
			Effect.andThen(
				projectComputers.applyNetwork({ workspaceId: row.workspaceId, projectId: row.projectId }),
			),
		);

	/** The project a proof that reaches it names. */
	const projectOf = <P, J>(reach: ReachesProject<P, J>): Project => ({
		workspaceId: reach.workspace,
		projectId: reach.project.value,
	});

	return Service.of({
		settings: (canManage) =>
			operation("settings", settingsOf(canManage.inWorkspace.workspace.value)),

		addHost: (canManage, host) =>
			operation(
				"addHost",
				Effect.gen(function* () {
					const workspaceId = canManage.inWorkspace.workspace.value;
					if (!TRUSTED_HOSTS.includes(host)) {
						yield* query((db) =>
							db
								.insert(allowedHost)
								.values({ workspaceId, host, addedById: canManage.actor.memberId })
								.onConflictDoNothing(),
						);
						yield* projectComputers.applyNetwork({ workspaceId });
					}
					return yield* settingsOf(workspaceId);
				}),
			),

		removeHost: (canManage, host) =>
			operation(
				"removeHost",
				Effect.gen(function* () {
					const workspaceId = canManage.inWorkspace.workspace.value;
					const removed = yield* query((db) =>
						db
							.delete(allowedHost)
							.where(and(eq(allowedHost.workspaceId, workspaceId), eq(allowedHost.host, host)))
							.returning({ host: allowedHost.host }),
					);
					if (removed.length > 0) yield* projectComputers.applyNetwork({ workspaceId });
					return yield* settingsOf(workspaceId);
				}),
			),

		blockHost: (canManage, host) =>
			operation(
				"blockHost",
				Effect.gen(function* () {
					const workspaceId = canManage.inWorkspace.workspace.value;
					const blocked = yield* query((db) =>
						db
							.insert(blockedHost)
							.values({ workspaceId, host, blockedById: canManage.actor.memberId })
							.onConflictDoNothing()
							.returning({ host: blockedHost.host }),
					);
					if (blocked.length > 0) yield* projectComputers.applyNetwork({ workspaceId });
					return yield* settingsOf(workspaceId);
				}),
			),

		unblockHost: (canManage, host) =>
			operation(
				"unblockHost",
				Effect.gen(function* () {
					const workspaceId = canManage.inWorkspace.workspace.value;
					const unblocked = yield* query((db) =>
						db
							.delete(blockedHost)
							.where(and(eq(blockedHost.workspaceId, workspaceId), eq(blockedHost.host, host)))
							.returning({ host: blockedHost.host }),
					);
					if (unblocked.length > 0) yield* projectComputers.applyNetwork({ workspaceId });
					return yield* settingsOf(workspaceId);
				}),
			),

		projectSettings: (reach) => operation("projectSettings", projectSettingsOf(projectOf(reach))),

		addProjectHost: (canChange, host) =>
			operation(
				"addProjectHost",
				Effect.gen(function* () {
					const project = projectOf(canChange.reach);
					const by = yield* blockFor(project.workspaceId, host);
					if (by !== undefined) return yield* new ComputerHostBlocked({ host, by });
					if (!TRUSTED_HOSTS.includes(host)) {
						yield* addToProject({ ...project, host, addedById: canChange.member.actor.memberId });
					}
					return yield* projectSettingsOf(project);
				}),
			),

		removeProjectHost: (canChange, host) =>
			operation(
				"removeProjectHost",
				Effect.gen(function* () {
					const project = projectOf(canChange.reach);
					const removed = yield* query((db) =>
						db
							.delete(projectAllowedHost)
							.where(
								and(
									eq(projectAllowedHost.projectId, project.projectId),
									eq(projectAllowedHost.host, host),
								),
							)
							.returning({ host: projectAllowedHost.host }),
					);
					if (removed.length > 0) yield* projectComputers.applyNetwork(project);
					return yield* projectSettingsOf(project);
				}),
			),

		grantRequest: ({ turnId, sdkToolCallId, host }) =>
			operation(
				"grantRequest",
				Effect.gen(function* (): Effect.fn.Return<Grant, never, Database> {
					const [call] = yield* query((db) =>
						db
							.select({
								workspaceId: placedChat.workspaceId,
								projectId: placedChat.projectId,
								approvalStatus: toolCall.approvalStatus,
								decidedById: toolCall.decidedById,
							})
							.from(toolCall)
							.innerJoin(turn, eq(turn.id, toolCall.turnId))
							.innerJoin(placedChat, eq(placedChat.id, toolCall.chatId))
							.where(and(eq(toolCall.turnId, turnId), eq(toolCall.sdkToolCallId, sdkToolCallId)))
							.limit(1),
					);
					if (call?.approvalStatus !== "allowed" || call.projectId === null) {
						return { kind: "not-allowed" };
					}
					// Blocked while the request waited for its answer.
					const by = yield* blockFor(call.workspaceId, host);
					if (by !== undefined) return { kind: "blocked", by };
					if (!TRUSTED_HOSTS.includes(host)) {
						yield* addToProject({
							workspaceId: call.workspaceId,
							projectId: call.projectId,
							host,
							addedById: call.decidedById,
						});
					}
					return { kind: "added" };
				}),
			),
	});
});

export const layerNoDeps = processLayer(Layer.effect(Service, make));

export const layer = layerNoDeps.pipe(
	Layer.provide([ProjectComputers.layer, ComputerProviderStore.layer, Computers.layer]),
);

interface Project {
	readonly workspaceId: string;
	readonly projectId: string;
}

function nameOf(names: ReadonlyMap<string, string>, memberId: string | null) {
	return (memberId && names.get(memberId)) ?? null;
}
