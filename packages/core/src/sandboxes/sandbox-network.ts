export * as SandboxNetwork from "./sandbox-network.ts";

import {
	type AgentSandboxNetwork,
	SANDBOX_NETWORK_MODE_DEFAULT,
	type SandboxNetworkSettings,
} from "@sugabots/contracts";
import { UserText, userText } from "@sugabots/errors";
import { and, eq, inArray } from "drizzle-orm";
import { Context, Data, Effect, Layer } from "effect";
import type { AuthorizationDenied } from "../authorization/access.ts";
import { Authorization } from "../authorization/authorization.ts";
import type { CurrentActor } from "../authorization/current-actor.ts";
import { type Database, query, serviceOperations } from "../database/database.ts";
import {
	sandboxAgentAllowedHost,
	sandboxAllowedHost,
	sandboxBlockedHost,
	thread,
	toolCall,
	turn,
	user,
} from "../database/schema.ts";
import type { UserFacing } from "../user-message.ts";
import { AgentSandboxes } from "./agent-sandboxes.ts";
import {
	addedHostsOf,
	agentAddedHostsOf,
	blockedHostsOf,
	blockOn,
	TRUSTED_HOSTS,
} from "./allowed-hosts.ts";
import { SandboxProviderRepository } from "./sandbox-provider-repository.ts";
import { Sandboxes } from "./sandboxes.ts";

/**
 * Where computers may connect to. Every bot's computer reaches
 * {@link TRUSTED_HOSTS} and the hosts its workspace added, and each bot adds
 * its own; the workspace's blocks keep hosts out of every computer's reach,
 * whatever allows them. A change reaches running computers at once, and the
 * others when they are next opened.
 *
 * The workspace's lists take the current actor's `workspace.providers.manage`
 * on the workspace, named by its id or its slug. A bot's own list takes
 * `agent.settings.read` to see and `sandbox.manage` to change.
 */
export interface Interface {
	readonly settings: (
		workspace: string,
	) => Effect.Effect<SandboxNetworkSettings, AuthorizationDenied, CurrentActor.Service>;
	readonly addHost: (input: {
		workspace: string;
		host: string;
	}) => Effect.Effect<SandboxNetworkSettings, AuthorizationDenied, CurrentActor.Service>;
	/** Removing a host the workspace never added changes nothing. */
	readonly removeHost: (input: {
		workspace: string;
		host: string;
	}) => Effect.Effect<SandboxNetworkSettings, AuthorizationDenied, CurrentActor.Service>;
	readonly blockHost: (input: {
		workspace: string;
		host: string;
	}) => Effect.Effect<SandboxNetworkSettings, AuthorizationDenied, CurrentActor.Service>;
	/** Unblocking a host the workspace never blocked changes nothing. */
	readonly unblockHost: (input: {
		workspace: string;
		host: string;
	}) => Effect.Effect<SandboxNetworkSettings, AuthorizationDenied, CurrentActor.Service>;
	readonly agentSettings: (
		agentId: string,
	) => Effect.Effect<AgentSandboxNetwork, AuthorizationDenied, CurrentActor.Service>;
	/** Adding a host the workspace blocked fails with {@link HostBlocked}. */
	readonly addAgentHost: (input: {
		agentId: string;
		host: string;
	}) => Effect.Effect<AgentSandboxNetwork, AuthorizationDenied | HostBlocked, CurrentActor.Service>;
	/** Removing a host the bot never added changes nothing. */
	readonly removeAgentHost: (input: {
		agentId: string;
		host: string;
	}) => Effect.Effect<AgentSandboxNetwork, AuthorizationDenied, CurrentActor.Service>;
	/**
	 * The workspace's block that keeps `host` out of its sandboxes, if any, so
	 * a request for it is refused without asking anyone.
	 */
	readonly blockOn: (workspaceId: string, host: string) => Effect.Effect<string | undefined>;
	/**
	 * Adds `host` to the bot of the turn whose call `sdkToolCallId` asked for
	 * it, if a person allowed that call and the workspace hasn't blocked the
	 * host since.
	 */
	readonly grantRequest: (input: {
		turnId: string;
		sdkToolCallId: string;
		host: string;
	}) => Effect.Effect<Grant>;
}

/** What became of an allowed request: added, refused by a block, or never allowed. */
export type Grant = { kind: "added" } | { kind: "blocked"; by: string } | { kind: "not-allowed" };

export class Service extends Context.Service<Service, Interface>()(
	"@sugabots/core/SandboxNetwork",
) {}

export const make = Effect.gen(function* () {
	const operation = yield* serviceOperations<Interface>("SandboxNetwork");
	const authorization = yield* Authorization.Service;
	const agentSandboxes = yield* AgentSandboxes.Service;
	const providers = yield* SandboxProviderRepository.Service;
	const sandboxes = yield* Sandboxes.Service;

	const manage = (workspace: string) =>
		authorization.workspace(workspace, "workspace.providers.manage");

	/**
	 * How the workspace's sandboxes reach the internet, by its enabled
	 * provider, and whether its blocks keep hosts out.
	 */
	const networkOf = (workspaceId: string) =>
		Effect.map(providers.enabled(workspaceId), (enabled) => {
			if (!enabled) return { mode: SANDBOX_NETWORK_MODE_DEFAULT, blocking: true };
			const { networkMode, capabilities } = sandboxes.forConnection(enabled.connection);
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
					blockedAt: row.createdAt.toISOString(),
				})),
			} satisfies SandboxNetworkSettings;
		});

	const agentSettingsOf = (agent: Agent) =>
		Effect.gen(function* () {
			const [network, workspaceAdded, agentAdded, blocked] = yield* Effect.all([
				networkOf(agent.workspaceId),
				addedHostsOf(agent.workspaceId),
				agentAddedHostsOf(agent),
				blockedHostsOf(agent.workspaceId),
			]);
			const blocks = blocked.map((row) => row.host);
			const names = yield* namesOf(agentAdded.map((row) => row.addedById));
			return {
				...network,
				workspaceHosts: [...TRUSTED_HOSTS, ...workspaceAdded.map((row) => row.host)].map(
					(host) => ({ host, blockedBy: blockOn(host, blocks) ?? null }),
				),
				addedHosts: agentAdded.map((row) => ({
					host: row.host,
					addedByName: nameOf(names, row.addedById),
					addedAt: row.createdAt.toISOString(),
					blockedBy: blockOn(row.host, blocks) ?? null,
				})),
			} satisfies AgentSandboxNetwork;
		});

	const blockFor = (workspaceId: string, host: string) =>
		Effect.map(blockedHostsOf(workspaceId), (blocked) =>
			blockOn(
				host,
				blocked.map((row) => row.host),
			),
		);

	const addToAgent = (row: typeof sandboxAgentAllowedHost.$inferInsert) =>
		query((db) => db.insert(sandboxAgentAllowedHost).values(row).onConflictDoNothing()).pipe(
			Effect.andThen(
				agentSandboxes.applyNetwork({ workspaceId: row.workspaceId, agentId: row.agentId }),
			),
		);

	const agentOf = (standing: { agent: { id: string; workspaceId: string } }): Agent => ({
		workspaceId: standing.agent.workspaceId,
		agentId: standing.agent.id,
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
								.insert(sandboxAllowedHost)
								.values({ workspaceId, host, addedById: actor.userId })
								.onConflictDoNothing(),
						);
						yield* agentSandboxes.applyNetwork({ workspaceId });
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
							.delete(sandboxAllowedHost)
							.where(
								and(
									eq(sandboxAllowedHost.workspaceId, workspaceId),
									eq(sandboxAllowedHost.host, host),
								),
							)
							.returning({ host: sandboxAllowedHost.host }),
					);
					if (removed.length > 0) yield* agentSandboxes.applyNetwork({ workspaceId });
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
							.insert(sandboxBlockedHost)
							.values({ workspaceId, host, blockedById: actor.userId })
							.onConflictDoNothing()
							.returning({ host: sandboxBlockedHost.host }),
					);
					if (blocked.length > 0) yield* agentSandboxes.applyNetwork({ workspaceId });
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
							.delete(sandboxBlockedHost)
							.where(
								and(
									eq(sandboxBlockedHost.workspaceId, workspaceId),
									eq(sandboxBlockedHost.host, host),
								),
							)
							.returning({ host: sandboxBlockedHost.host }),
					);
					if (unblocked.length > 0) yield* agentSandboxes.applyNetwork({ workspaceId });
					return yield* settingsOf(workspaceId);
				}),
			),

		agentSettings: (agentId) =>
			operation(
				"agentSettings",
				Effect.flatMap(authorization.agent(agentId, "agent.settings.read"), (standing) =>
					agentSettingsOf(agentOf(standing)),
				),
			),

		addAgentHost: ({ agentId, host }) =>
			operation(
				"addAgentHost",
				Effect.gen(function* () {
					const standing = yield* authorization.agent(agentId, "sandbox.manage");
					const agent = agentOf(standing);
					const by = yield* blockFor(agent.workspaceId, host);
					if (by !== undefined) return yield* new HostBlocked({ host, by });
					if (!TRUSTED_HOSTS.includes(host)) {
						yield* addToAgent({ ...agent, host, addedById: standing.actor.userId });
					}
					return yield* agentSettingsOf(agent);
				}),
			),

		removeAgentHost: ({ agentId, host }) =>
			operation(
				"removeAgentHost",
				Effect.gen(function* () {
					const agent = agentOf(yield* authorization.agent(agentId, "sandbox.manage"));
					const removed = yield* query((db) =>
						db
							.delete(sandboxAgentAllowedHost)
							.where(
								and(
									eq(sandboxAgentAllowedHost.agentId, agent.agentId),
									eq(sandboxAgentAllowedHost.host, host),
								),
							)
							.returning({ host: sandboxAgentAllowedHost.host }),
					);
					if (removed.length > 0) yield* agentSandboxes.applyNetwork(agent);
					return yield* agentSettingsOf(agent);
				}),
			),

		blockOn: (workspaceId, host) => operation("blockOn", blockFor(workspaceId, host)),

		grantRequest: ({ turnId, sdkToolCallId, host }) =>
			operation(
				"grantRequest",
				Effect.gen(function* (): Effect.fn.Return<Grant, never, Database> {
					const [call] = yield* query((db) =>
						db
							.select({
								workspaceId: thread.workspaceId,
								agentId: turn.agentId,
								approvalStatus: toolCall.approvalStatus,
								decidedById: toolCall.decidedById,
							})
							.from(toolCall)
							.innerJoin(turn, eq(turn.id, toolCall.turnId))
							.innerJoin(thread, eq(thread.id, toolCall.threadId))
							.where(and(eq(toolCall.turnId, turnId), eq(toolCall.sdkToolCallId, sdkToolCallId)))
							.limit(1),
					);
					if (call?.approvalStatus !== "allowed") return { kind: "not-allowed" };
					// Blocked while the request waited for its answer.
					const by = yield* blockFor(call.workspaceId, host);
					if (by !== undefined) return { kind: "blocked", by };
					if (!TRUSTED_HOSTS.includes(host)) {
						yield* addToAgent({
							workspaceId: call.workspaceId,
							agentId: call.agentId,
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
		AgentSandboxes.layer,
		SandboxProviderRepository.layer,
		Sandboxes.layer,
	]),
);

interface Agent {
	readonly workspaceId: string;
	readonly agentId: string;
}

/** The host is blocked for the workspace, so no bot may allow it. */
export class HostBlocked
	extends Data.TaggedError("SandboxHostBlocked")<{ host: string; by: string }>
	implements UserFacing
{
	get userMessage() {
		const host = hostName(this.host);
		return this.by === this.host
			? userText`${host} is blocked for this workspace's sandboxes.`
			: userText`${host} would reach ${hostName(this.by)}, which is blocked for this workspace's sandboxes.`;
	}
}

/** A host as people read it. Hosts are domain names, checked by `sandboxHostSchema` on the way in. */
export function hostName(host: string) {
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
