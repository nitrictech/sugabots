export * as SandboxNetwork from "./sandbox-network.ts";

import type { PodSandboxNetwork, SandboxNetworkSettings } from "@sugabots/contracts";
import { and, eq, inArray } from "drizzle-orm";
import { Context, Data, Effect, Layer } from "effect";
import type { AuthorizationDenied } from "../authorization/access.ts";
import { Authorization } from "../authorization/authorization.ts";
import type { CurrentActor } from "../authorization/current-actor.ts";
import { type Database, query, serviceOperations } from "../database/database.ts";
import {
	sandboxAllowedHost,
	sandboxBlockedHost,
	sandboxPodAllowedHost,
	thread,
	toolCall,
	user,
} from "../database/schema.ts";
import { type UserFacing, UserMessage } from "../user-message.ts";
import {
	addedHostsOf,
	blockedHostsOf,
	blockOn,
	podAddedHostsOf,
	TRUSTED_HOSTS,
} from "./allowed-hosts.ts";
import { PodSandboxes } from "./pod-sandboxes.ts";

/**
 * Where sandboxes may connect to. Every pod's sandbox reaches
 * {@link TRUSTED_HOSTS} and the hosts its workspace added, and each pod adds
 * its own; the workspace's blocks keep hosts out of every pod's reach,
 * whatever allows them. A change reaches running sandboxes at once, and the
 * others when they are next opened.
 *
 * The workspace's lists take the current actor's `workspace.providers.manage`
 * on the workspace, named by its id or its slug. A pod's own list takes
 * `pod.read` to see and `sandbox.manage` to change.
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
	readonly podSettings: (
		podId: string,
	) => Effect.Effect<PodSandboxNetwork, AuthorizationDenied, CurrentActor.Service>;
	/** Adding a host the workspace blocked fails with {@link HostBlocked}. */
	readonly addPodHost: (input: {
		podId: string;
		host: string;
	}) => Effect.Effect<PodSandboxNetwork, AuthorizationDenied | HostBlocked, CurrentActor.Service>;
	/** Removing a host the pod never added changes nothing. */
	readonly removePodHost: (input: {
		podId: string;
		host: string;
	}) => Effect.Effect<PodSandboxNetwork, AuthorizationDenied, CurrentActor.Service>;
	/**
	 * The workspace's block that keeps `host` out of its sandboxes, if any, so
	 * a request for it is refused without asking anyone.
	 */
	readonly blockOn: (workspaceId: string, host: string) => Effect.Effect<string | undefined>;
	/**
	 * Adds `host` to the pod of the turn whose call `sdkToolCallId` asked for
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
	const podSandboxes = yield* PodSandboxes.Service;

	const manage = (workspace: string) =>
		authorization.workspace(workspace, "workspace.providers.manage");

	const settingsOf = (workspaceId: string) =>
		Effect.gen(function* () {
			const [added, blocked] = yield* Effect.all([
				addedHostsOf(workspaceId),
				blockedHostsOf(workspaceId),
			]);
			const names = yield* namesOf([
				...added.map((row) => row.addedById),
				...blocked.map((row) => row.blockedById),
			]);
			return {
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

	const podSettingsOf = (pod: Pod) =>
		Effect.gen(function* () {
			const [workspaceAdded, podAdded, blocked] = yield* Effect.all([
				addedHostsOf(pod.workspaceId),
				podAddedHostsOf(pod),
				blockedHostsOf(pod.workspaceId),
			]);
			const blocks = blocked.map((row) => row.host);
			const names = yield* namesOf(podAdded.map((row) => row.addedById));
			return {
				workspaceHosts: [...TRUSTED_HOSTS, ...workspaceAdded.map((row) => row.host)].map(
					(host) => ({ host, blockedBy: blockOn(host, blocks) ?? null }),
				),
				addedHosts: podAdded.map((row) => ({
					host: row.host,
					addedByName: nameOf(names, row.addedById),
					addedAt: row.createdAt.toISOString(),
					blockedBy: blockOn(row.host, blocks) ?? null,
				})),
			} satisfies PodSandboxNetwork;
		});

	const blockFor = (workspaceId: string, host: string) =>
		Effect.map(blockedHostsOf(workspaceId), (blocked) =>
			blockOn(
				host,
				blocked.map((row) => row.host),
			),
		);

	const addToPod = (row: typeof sandboxPodAllowedHost.$inferInsert) =>
		query((db) => db.insert(sandboxPodAllowedHost).values(row).onConflictDoNothing()).pipe(
			Effect.andThen(
				podSandboxes.applyAllowedHosts({ workspaceId: row.workspaceId, podId: row.podId }),
			),
		);

	const podOf = (standing: { pod: { id: string; workspaceId: string } }): Pod => ({
		workspaceId: standing.pod.workspaceId,
		podId: standing.pod.id,
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
						yield* podSandboxes.applyAllowedHosts({ workspaceId });
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
					if (removed.length > 0) yield* podSandboxes.applyAllowedHosts({ workspaceId });
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
					if (blocked.length > 0) yield* podSandboxes.applyAllowedHosts({ workspaceId });
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
					if (unblocked.length > 0) yield* podSandboxes.applyAllowedHosts({ workspaceId });
					return yield* settingsOf(workspaceId);
				}),
			),

		podSettings: (podId) =>
			operation(
				"podSettings",
				Effect.flatMap(authorization.pod(podId, "pod.read"), (standing) =>
					podSettingsOf(podOf(standing)),
				),
			),

		addPodHost: ({ podId, host }) =>
			operation(
				"addPodHost",
				Effect.gen(function* () {
					const standing = yield* authorization.pod(podId, "sandbox.manage");
					const pod = podOf(standing);
					const by = yield* blockFor(pod.workspaceId, host);
					if (by !== undefined) return yield* new HostBlocked({ host, by });
					if (!TRUSTED_HOSTS.includes(host)) {
						yield* addToPod({ ...pod, host, addedById: standing.actor.userId });
					}
					return yield* podSettingsOf(pod);
				}),
			),

		removePodHost: ({ podId, host }) =>
			operation(
				"removePodHost",
				Effect.gen(function* () {
					const pod = podOf(yield* authorization.pod(podId, "sandbox.manage"));
					const removed = yield* query((db) =>
						db
							.delete(sandboxPodAllowedHost)
							.where(
								and(
									eq(sandboxPodAllowedHost.podId, pod.podId),
									eq(sandboxPodAllowedHost.host, host),
								),
							)
							.returning({ host: sandboxPodAllowedHost.host }),
					);
					if (removed.length > 0) yield* podSandboxes.applyAllowedHosts(pod);
					return yield* podSettingsOf(pod);
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
								podId: thread.podId,
								approvalStatus: toolCall.approvalStatus,
								decidedById: toolCall.decidedById,
							})
							.from(toolCall)
							.innerJoin(thread, eq(thread.id, toolCall.threadId))
							.where(and(eq(toolCall.turnId, turnId), eq(toolCall.sdkToolCallId, sdkToolCallId)))
							.limit(1),
					);
					if (call?.approvalStatus !== "allowed") return { kind: "not-allowed" };
					// Blocked while the request waited for its answer.
					const by = yield* blockFor(call.workspaceId, host);
					if (by !== undefined) return { kind: "blocked", by };
					if (!TRUSTED_HOSTS.includes(host)) {
						yield* addToPod({
							workspaceId: call.workspaceId,
							podId: call.podId,
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

export const layer = layerNoDeps.pipe(Layer.provide([Authorization.layer, PodSandboxes.layer]));

interface Pod {
	readonly workspaceId: string;
	readonly podId: string;
}

/** The host is blocked for the workspace, so no pod may allow it. */
export class HostBlocked
	extends Data.TaggedError("SandboxHostBlocked")<{ host: string; by: string }>
	implements UserFacing
{
	get userMessage() {
		const host = hostName(this.host);
		return this.by === this.host
			? UserMessage.of`${host} is blocked for this workspace's sandboxes.`
			: UserMessage.of`${host} would reach ${hostName(this.by)}, which is blocked for this workspace's sandboxes.`;
	}
}

/** A host as people read it. Hosts are domain names, checked by `sandboxHostSchema` on the way in. */
export function hostName(host: string) {
	return UserMessage.unchecked(host);
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
