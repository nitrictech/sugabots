export * as BotComputerSetup from "./bot-computer-setup.ts";

import type { BotComputer, BotComputerDisk, ComputerDisk } from "@sugabots/contracts";
import { computerProviderPreset } from "@sugabots/contracts";
import { userText } from "@sugabots/errors";
import { and, eq } from "drizzle-orm";
import { Context, Data, Effect, Layer } from "effect";
import type { AuthorizationDenied } from "../authorization/access.ts";
import { Authorization } from "../authorization/authorization.ts";
import type { CurrentActor } from "../authorization/current-actor.ts";
import { Visibility } from "../authorization/visibility.ts";
import { query, serviceOperations } from "../database/database.ts";
import { bot as botTable } from "../database/schema.ts";
import type { UserFacing } from "../user-message.ts";
import { BotComputers } from "./bot-computers.ts";
import { ComputerProviderRepository } from "./computer-provider-repository.ts";
import type { Computers } from "./computers.ts";

/**
 * A bot's computer for the people looking after the bot: how it stands for
 * anyone who can see the bot, and, for those who may manage it, starting it
 * afresh or moving its work to a computer made from the current image.
 */
export interface Interface {
	readonly get: (
		botId: string,
	) => Effect.Effect<BotComputer, AuthorizationDenied, CurrentActor.Service>;
	/** How full the disks of the computers of the workspace's bots the actor sees are, of those measured. */
	readonly disks: (
		workspace: string,
	) => Effect.Effect<BotComputerDisk[], AuthorizationDenied, CurrentActor.Service>;
	readonly reset: (
		botId: string,
	) => Effect.Effect<
		BotComputer,
		AuthorizationDenied | BotComputers.ComputerInUse | Computers.Unavailable,
		CurrentActor.Service
	>;
	readonly upgrade: (
		botId: string,
	) => Effect.Effect<
		BotComputer,
		| AuthorizationDenied
		| NoComputerProvider
		| BotComputers.ComputerInUse
		| BotComputers.NoComputer
		| BotComputers.UpgradeFailed
		| Computers.Unavailable,
		CurrentActor.Service
	>;
}

export class Service extends Context.Service<Service, Interface>()(
	"@sugabots/core/BotComputerSetup",
) {}

export const make = Effect.gen(function* () {
	const operation = yield* serviceOperations<Interface>("BotComputerSetup");
	const authorization = yield* Authorization.Service;
	const visibility = yield* Visibility.Service;
	const botComputers = yield* BotComputers.Service;
	const providers = yield* ComputerProviderRepository.Service;

	const shown = (bot: BotComputers.Bot, canManage: boolean) =>
		Effect.gen(function* () {
			const current = yield* providers.enabled(bot.workspaceId);
			const status = yield* botComputers.status(bot, current);
			const providerEnabled = current !== undefined;
			if (status.kind === "none")
				return { computer: status, providerEnabled, canManage } satisfies BotComputer;
			const row = (yield* providers.list(bot.workspaceId)).find(
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
			} satisfies BotComputer;
		});

	const standingOn = (botId: string, permission: "bot.settings.read" | "computer.manage") =>
		Effect.map(authorization.bot(botId, permission), (standing) => ({
			bot: { workspaceId: standing.bot.workspaceId, botId: standing.bot.id },
			canManage: standing.may("computer.manage"),
		}));

	return Service.of({
		get: (botId) =>
			operation(
				"get",
				Effect.flatMap(standingOn(botId, "bot.settings.read"), ({ bot, canManage }) =>
					shown(bot, canManage),
				),
			),

		disks: (workspace) =>
			operation(
				"disks",
				Effect.gen(function* () {
					const { workspaceId } = yield* authorization.workspace(workspace, "workspace.read");
					const reachesBot = yield* visibility.reachesBot;
					const seen = new Set(
						(yield* query((db) =>
							db
								.select({ id: botTable.id })
								.from(botTable)
								.where(and(eq(botTable.workspaceId, workspaceId), reachesBot(botTable.id))),
						)).map(({ id }) => id),
					);
					const measured = yield* botComputers.disksIn(workspaceId);
					return measured
						.filter(({ botId }) => seen.has(botId))
						.map(({ botId, disk }) => ({ botId, disk: shownDisk(disk) }));
				}),
			),

		reset: (botId) =>
			operation(
				"reset",
				Effect.gen(function* () {
					const { bot } = yield* standingOn(botId, "computer.manage");
					yield* botComputers.reset(bot);
					return yield* shown(bot, true);
				}),
			),

		upgrade: (botId) =>
			operation(
				"upgrade",
				Effect.gen(function* () {
					const { bot } = yield* standingOn(botId, "computer.manage");
					const provider = yield* providers.enabled(bot.workspaceId);
					if (!provider) return yield* new NoComputerProvider();
					yield* botComputers.upgrade(bot, provider);
					return yield* shown(bot, true);
				}),
			),
	});
});

export const layerNoDeps = Layer.effect(Service, make);

export const layer = layerNoDeps.pipe(
	Layer.provide([
		Authorization.layer,
		Visibility.layer,
		BotComputers.layer,
		ComputerProviderRepository.layer,
	]),
);

function shownDisk(disk: BotComputers.MeasuredDisk): ComputerDisk {
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
