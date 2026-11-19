export * as ComputerNetwork from "./computer-network.ts";

import {
	COMPUTER_NETWORK_MODE_DEFAULT,
	type ComputerNetworkSettings,
	type ProjectComputerNetwork,
} from "@sugabots/contracts";
import { UserText, userText } from "@sugabots/errors";
import { and, eq, inArray } from "drizzle-orm";
import { Context, Data, Effect, Layer } from "effect";
import { type AuthorizationDenied, computerProjectIdOf } from "../authorization/access.ts";
import { Authorization } from "../authorization/authorization.ts";
import type { CurrentActor } from "../authorization/current-actor.ts";
import { type Database, query, serviceOperations } from "../database/database.ts";
import {
	allowedHost,
	blockedHost,
	placedConversation,
	projectAllowedHost,
	toolCall,
	turn,
	user,
} from "../database/schema.ts";
import type { UserFacing } from "../user-message.ts";
import {
	addedHostsOf,
	blockedHostsOf,
	blockOn,
	projectAddedHostsOf,
	TRUSTED_HOSTS,
} from "./allowed-hosts.ts";
import { ComputerProviderRepository } from "./computer-provider-repository.ts";
import { Computers } from "./computers.ts";
import { ProjectComputers } from "./project-computers.ts";

/**
 * Where computers may connect to. Every project's computer reaches
 * {@link TRUSTED_HOSTS} and the hosts its workspace added, and each project
 * adds its own, a bot's being its default project's; the workspace's blocks keep hosts out of every computer's reach,
 * whatever allows them. A change reaches running computers at once, and the
 * others when they are next opened.
 *
 * The workspace's lists take the current actor's `workspace.providers.manage`
 * on the workspace, named by its id or its slug. A project's own list takes
 * `computer.read` in it to see and `computer.manage` to change.
 */
export interface Interface {
	readonly settings: (
		workspace: string,
	) => Effect.Effect<ComputerNetworkSettings, AuthorizationDenied, CurrentActor.Service>;
	readonly addHost: (input: {
		workspace: string;
		host: string;
	}) => Effect.Effect<ComputerNetworkSettings, AuthorizationDenied, CurrentActor.Service>;
	/** Removing a host the workspace never added changes nothing. */
	readonly removeHost: (input: {
		workspace: string;
		host: string;
	}) => Effect.Effect<ComputerNetworkSettings, AuthorizationDenied, CurrentActor.Service>;
	readonly blockHost: (input: {
		workspace: string;
		host: string;
	}) => Effect.Effect<ComputerNetworkSettings, AuthorizationDenied, CurrentActor.Service>;
	/** Unblocking a host the workspace never blocked changes nothing. */
	readonly unblockHost: (input: {
		workspace: string;
		host: string;
	}) => Effect.Effect<ComputerNetworkSettings, AuthorizationDenied, CurrentActor.Service>;
	readonly projectSettings: (
		projectId: string,
	) => Effect.Effect<ProjectComputerNetwork, AuthorizationDenied, CurrentActor.Service>;
	/** Adding a host the workspace blocked fails with {@link HostBlocked}. */
	readonly addProjectHost: (input: {
		projectId: string;
		host: string;
	}) => Effect.Effect<
		ProjectComputerNetwork,
		AuthorizationDenied | HostBlocked,
		CurrentActor.Service
	>;
	/** Removing a host the project never added changes nothing. */
	readonly removeProjectHost: (input: {
		projectId: string;
		host: string;
	}) => Effect.Effect<ProjectComputerNetwork, AuthorizationDenied, CurrentActor.Service>;
	/**
	 * Adds `host` to the project whose computer the turn worked on whose call
	 * `sdkToolCallId` asked for it, if a person allowed that call and the
	 * workspace hasn't blocked the host since.
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
) {}

export const make = Effect.gen(function* () {
	const operation = yield* serviceOperations<Interface>("ComputerNetwork");
	const authorization = yield* Authorization.Service;
	const projectComputers = yield* ProjectComputers.Service;
	const providers = yield* ComputerProviderRepository.Service;
	const computers = yield* Computers.Service;

	const manage = (workspace: string) =>
		authorization.workspace(workspace, "workspace.providers.manage");

	/**
	 * How the workspace's computers reach the internet, by its enabled
	 * provider, and whether its blocks keep hosts out.
	 */
	const networkOf = (workspaceId: string) =>
		Effect.map(providers.enabled(workspaceId), (enabled) => {
			if (!enabled) return { mode: COMPUTER_NETWORK_MODE_DEFAULT, blocking: true };
			const { networkMode, capabilities } = computers.forConnection(enabled.connection);
			return {
				mode: networkMode,
				blocking: networkMode === "allowlist" || capabilities.blocksHosts,
			};
		});

	const settingsOf = (workspaceId: string) =>
		Effect.gen(function* () {
			const [network, added, blocked] = yield* Effect.all([
				networkOf(workspaceId),
				addedHostsOf(workspaceId),
				blockedHostsOf(workspaceId),
			]);
			const names = yield* namesOf([
				...added.map((row) => row.addedById),
				...blocked.map((row) => row.blockedById),
			]);
			return {
				...network,
				trustedHosts: TRUSTED_HOSTS,
				addedHosts: added.map((row) => ({
					host: row.host,
					addedByName: nameOf(names, row.addedById),
					addedAt: row.createdAt.toISOString(),
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
			const names = yield* namesOf(projectAdded.map((row) => row.addedById));
			return {
				...network,
				workspaceHosts: [...TRUSTED_HOSTS, ...workspaceAdded.map((row) => row.host)].map(
					(host) => ({ host, blockedBy: blockOn(host, blocks) ?? null }),
				),
				addedHosts: projectAdded.map((row) => ({
					host: row.host,
					addedByName: nameOf(names, row.addedById),
					addedAt: row.createdAt.toISOString(),
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

	const projectOf = (standing: { project: { id: string; workspaceId: string } }): Project => ({
		workspaceId: standing.project.workspaceId,
		projectId: standing.project.id,
	});

	return Service.of({
		settings: (workspace) =>
			operation(
				"settings",
				Effect.flatMap(manage(workspace), ({ workspaceId }) => settingsOf(workspaceId)),
			),

		addHost: ({ workspace, host }) =>
			operation(
				"addHost",
				Effect.gen(function* () {
					const { workspaceId, actor } = yield* manage(workspace);
					if (!TRUSTED_HOSTS.includes(host)) {
						yield* query((db) =>
							db
								.insert(allowedHost)
								.values({ workspaceId, host, addedById: actor.userId })
								.onConflictDoNothing(),
						);
						yield* projectComputers.applyNetwork({ workspaceId });
					}
					return yield* settingsOf(workspaceId);
				}),
			),

		removeHost: ({ workspace, host }) =>
			operation(
				"removeHost",
				Effect.gen(function* () {
					const { workspaceId } = yield* manage(workspace);
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

		blockHost: ({ workspace, host }) =>
			operation(
				"blockHost",
				Effect.gen(function* () {
					const { workspaceId, actor } = yield* manage(workspace);
					const blocked = yield* query((db) =>
						db
							.insert(blockedHost)
							.values({ workspaceId, host, blockedById: actor.userId })
							.onConflictDoNothing()
							.returning({ host: blockedHost.host }),
					);
					if (blocked.length > 0) yield* projectComputers.applyNetwork({ workspaceId });
					return yield* settingsOf(workspaceId);
				}),
			),

		unblockHost: ({ workspace, host }) =>
			operation(
				"unblockHost",
				Effect.gen(function* () {
					const { workspaceId } = yield* manage(workspace);
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

		projectSettings: (projectId) =>
			operation(
				"projectSettings",
				Effect.flatMap(authorization.project(projectId, "computer.read"), (standing) =>
					projectSettingsOf(projectOf(standing)),
				),
			),

		addProjectHost: ({ projectId, host }) =>
			operation(
				"addProjectHost",
				Effect.gen(function* () {
					const standing = yield* authorization.project(projectId, "computer.manage");
					const project = projectOf(standing);
					const by = yield* blockFor(project.workspaceId, host);
					if (by !== undefined) return yield* new HostBlocked({ host, by });
					if (!TRUSTED_HOSTS.includes(host)) {
						yield* addToProject({ ...project, host, addedById: standing.actor.userId });
					}
					return yield* projectSettingsOf(project);
				}),
			),

		removeProjectHost: ({ projectId, host }) =>
			operation(
				"removeProjectHost",
				Effect.gen(function* () {
					const project = projectOf(yield* authorization.project(projectId, "computer.manage"));
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
								workspaceId: placedConversation.workspaceId,
								projectId: computerProjectIdOf(placedConversation, turn.botId),
								approvalStatus: toolCall.approvalStatus,
								decidedById: toolCall.decidedById,
							})
							.from(toolCall)
							.innerJoin(turn, eq(turn.id, toolCall.turnId))
							.innerJoin(placedConversation, eq(placedConversation.id, toolCall.conversationId))
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

export const layerNoDeps = Layer.effect(Service, make);

export const layer = layerNoDeps.pipe(
	Layer.provide([
		Authorization.layer,
		ProjectComputers.layer,
		ComputerProviderRepository.layer,
		Computers.layer,
	]),
);

interface Project {
	readonly workspaceId: string;
	readonly projectId: string;
}

/** The host is blocked for the workspace, so no project may allow it. */
export class HostBlocked
	extends Data.TaggedError("ComputerHostBlocked")<{ host: string; by: string }>
	implements UserFacing
{
	get userMessage() {
		const host = hostName(this.host);
		return this.by === this.host
			? userText`${host} is blocked for this workspace's computers.`
			: userText`${host} would reach ${hostName(this.by)}, which is blocked for this workspace's computers.`;
	}
}

/** A host as people read it. Hosts are domain names, checked by `computerHostSchema` on the way in. */
function hostName(host: string) {
	return UserText.unchecked(host);
}

const namesOf = (userIds: ReadonlyArray<string | null>) => {
	const ids = [...new Set(userIds.filter((id) => id !== null))];
	return Effect.map(
		ids.length === 0
			? Effect.succeed([])
			: query((db) =>
					db.select({ id: user.id, name: user.name }).from(user).where(inArray(user.id, ids)),
				),
		(rows) => new Map(rows.map((row) => [row.id, row.name])),
	);
};

function nameOf(names: ReadonlyMap<string, string>, userId: string | null) {
	return (userId && names.get(userId)) ?? null;
}
