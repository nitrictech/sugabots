export * as ComputerNetwork from "./computer-network.ts";

import {
	type BotComputerNetwork,
	COMPUTER_NETWORK_MODE_DEFAULT,
	type ComputerNetworkSettings,
} from "@sugabots/contracts";
import { UserText, userText } from "@sugabots/errors";
import { and, eq, inArray } from "drizzle-orm";
import { Context, Data, Effect, Layer } from "effect";
import type { AuthorizationDenied } from "../authorization/access.ts";
import { Authorization } from "../authorization/authorization.ts";
import type { CurrentActor } from "../authorization/current-actor.ts";
import { type Database, query, serviceOperations } from "../database/database.ts";
import {
	allowedHost,
	blockedHost,
	botAllowedHost,
	conversation,
	toolCall,
	turn,
	user,
} from "../database/schema.ts";
import type { UserFacing } from "../user-message.ts";
import {
	addedHostsOf,
	blockedHostsOf,
	blockOn,
	botAddedHostsOf,
	TRUSTED_HOSTS,
} from "./allowed-hosts.ts";
import { BotComputers } from "./bot-computers.ts";
import { ComputerProviderRepository } from "./computer-provider-repository.ts";
import { Computers } from "./computers.ts";

/**
 * Where computers may connect to. Every bot's computer reaches
 * {@link TRUSTED_HOSTS} and the hosts its workspace added, and each bot adds
 * its own; the workspace's blocks keep hosts out of every computer's reach,
 * whatever allows them. A change reaches running computers at once, and the
 * others when they are next opened.
 *
 * The workspace's lists take the current actor's `workspace.providers.manage`
 * on the workspace, named by its id or its slug. A bot's own list takes
 * `bot.settings.read` to see and `computer.manage` to change.
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
	readonly botSettings: (
		botId: string,
	) => Effect.Effect<BotComputerNetwork, AuthorizationDenied, CurrentActor.Service>;
	/** Adding a host the workspace blocked fails with {@link HostBlocked}. */
	readonly addBotHost: (input: {
		botId: string;
		host: string;
	}) => Effect.Effect<BotComputerNetwork, AuthorizationDenied | HostBlocked, CurrentActor.Service>;
	/** Removing a host the bot never added changes nothing. */
	readonly removeBotHost: (input: {
		botId: string;
		host: string;
	}) => Effect.Effect<BotComputerNetwork, AuthorizationDenied, CurrentActor.Service>;
	/**
	 * The workspace's block that keeps `host` out of its computers, if any, so
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
type Grant = { kind: "added" } | { kind: "blocked"; by: string } | { kind: "not-allowed" };

export class Service extends Context.Service<Service, Interface>()(
	"@sugabots/core/ComputerNetwork",
) {}

export const make = Effect.gen(function* () {
	const operation = yield* serviceOperations<Interface>("ComputerNetwork");
	const authorization = yield* Authorization.Service;
	const botComputers = yield* BotComputers.Service;
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

	const botSettingsOf = (bot: Bot) =>
		Effect.gen(function* () {
			const [network, workspaceAdded, botAdded, blocked] = yield* Effect.all([
				networkOf(bot.workspaceId),
				addedHostsOf(bot.workspaceId),
				botAddedHostsOf(bot),
				blockedHostsOf(bot.workspaceId),
			]);
			const blocks = blocked.map((row) => row.host);
			const names = yield* namesOf(botAdded.map((row) => row.addedById));
			return {
				...network,
				workspaceHosts: [...TRUSTED_HOSTS, ...workspaceAdded.map((row) => row.host)].map(
					(host) => ({ host, blockedBy: blockOn(host, blocks) ?? null }),
				),
				addedHosts: botAdded.map((row) => ({
					host: row.host,
					addedByName: nameOf(names, row.addedById),
					addedAt: row.createdAt.toISOString(),
					blockedBy: blockOn(row.host, blocks) ?? null,
				})),
			} satisfies BotComputerNetwork;
		});

	const blockFor = (workspaceId: string, host: string) =>
		Effect.map(blockedHostsOf(workspaceId), (blocked) =>
			blockOn(
				host,
				blocked.map((row) => row.host),
			),
		);

	const addToBot = (row: typeof botAllowedHost.$inferInsert) =>
		query((db) => db.insert(botAllowedHost).values(row).onConflictDoNothing()).pipe(
			Effect.andThen(botComputers.applyNetwork({ workspaceId: row.workspaceId, botId: row.botId })),
		);

	const botOf = (standing: { bot: { id: string; workspaceId: string } }): Bot => ({
		workspaceId: standing.bot.workspaceId,
		botId: standing.bot.id,
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
						yield* botComputers.applyNetwork({ workspaceId });
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
					if (removed.length > 0) yield* botComputers.applyNetwork({ workspaceId });
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
					if (blocked.length > 0) yield* botComputers.applyNetwork({ workspaceId });
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
					if (unblocked.length > 0) yield* botComputers.applyNetwork({ workspaceId });
					return yield* settingsOf(workspaceId);
				}),
			),

		botSettings: (botId) =>
			operation(
				"botSettings",
				Effect.flatMap(authorization.bot(botId, "bot.settings.read"), (standing) =>
					botSettingsOf(botOf(standing)),
				),
			),

		addBotHost: ({ botId, host }) =>
			operation(
				"addBotHost",
				Effect.gen(function* () {
					const standing = yield* authorization.bot(botId, "computer.manage");
					const bot = botOf(standing);
					const by = yield* blockFor(bot.workspaceId, host);
					if (by !== undefined) return yield* new HostBlocked({ host, by });
					if (!TRUSTED_HOSTS.includes(host)) {
						yield* addToBot({ ...bot, host, addedById: standing.actor.userId });
					}
					return yield* botSettingsOf(bot);
				}),
			),

		removeBotHost: ({ botId, host }) =>
			operation(
				"removeBotHost",
				Effect.gen(function* () {
					const bot = botOf(yield* authorization.bot(botId, "computer.manage"));
					const removed = yield* query((db) =>
						db
							.delete(botAllowedHost)
							.where(and(eq(botAllowedHost.botId, bot.botId), eq(botAllowedHost.host, host)))
							.returning({ host: botAllowedHost.host }),
					);
					if (removed.length > 0) yield* botComputers.applyNetwork(bot);
					return yield* botSettingsOf(bot);
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
								workspaceId: conversation.workspaceId,
								botId: turn.botId,
								approvalStatus: toolCall.approvalStatus,
								decidedById: toolCall.decidedById,
							})
							.from(toolCall)
							.innerJoin(turn, eq(turn.id, toolCall.turnId))
							.innerJoin(conversation, eq(conversation.id, toolCall.conversationId))
							.where(and(eq(toolCall.turnId, turnId), eq(toolCall.sdkToolCallId, sdkToolCallId)))
							.limit(1),
					);
					if (call?.approvalStatus !== "allowed") return { kind: "not-allowed" };
					// Blocked while the request waited for its answer.
					const by = yield* blockFor(call.workspaceId, host);
					if (by !== undefined) return { kind: "blocked", by };
					if (!TRUSTED_HOSTS.includes(host)) {
						yield* addToBot({
							workspaceId: call.workspaceId,
							botId: call.botId,
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
		BotComputers.layer,
		ComputerProviderRepository.layer,
		Computers.layer,
	]),
);

interface Bot {
	readonly workspaceId: string;
	readonly botId: string;
}

/** The host is blocked for the workspace, so no bot may allow it. */
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
