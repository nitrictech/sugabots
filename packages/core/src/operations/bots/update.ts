import { botsContracts } from "@sugabots/contracts/operations/bots";
import { Effect } from "effect";
import { proveCanChangeBotReach } from "../../proofs/bot-permissions.ts";
import { proveCanManageBot } from "../../proofs/can-manage-bot.ts";
import { named } from "../../proofs/proof.ts";
import { Bots } from "../../workspaces/bots/bots.ts";

import { defineOperation } from "../operation.ts";
import { underBotsLock } from "./locking.ts";

/**
 * Proves changes to bot reach and desktop use under the workspace's lock.
 */
export const update = defineOperation(botsContracts["bots.update"], (principal, input) =>
	Effect.gen(function* () {
		const bots = yield* Bots.Service;
		if (input.changes.visibility === undefined && input.changes.usesComputer === undefined) {
			return yield* named(principal, input.botId, (principal, bot) =>
				Effect.flatMap(proveCanManageBot(principal, bot), (canManage) =>
					bots.update(canManage, input.changes),
				),
			);
		}
		return yield* underBotsLock(principal, input.botId, (lock) =>
			named(input.botId, (bot) =>
				Effect.gen(function* () {
					const canManage = yield* proveCanManageBot(lock.principal, bot);
					const canChangeReach = yield* proveCanChangeBotReach(lock, canManage);
					return yield* bots.update(canChangeReach, input.changes);
				}),
			),
		);
	}),
);
