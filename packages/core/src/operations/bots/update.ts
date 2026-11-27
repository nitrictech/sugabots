import { ResourceHidden } from "@sugabots/contracts/errors/proofs";
import { botsContracts } from "@sugabots/contracts/operations/bots";
import { Effect } from "effect";
import { Turns } from "../../chats/turns/turns.ts";
import { proveCanChangeBotReach } from "../../proofs/bot-permissions.ts";
import { proveCanManageBot } from "../../proofs/can-manage-bot.ts";
import { named } from "../../proofs/proof.ts";
import { underWorkspaceLock } from "../../proofs/workspace-lock.ts";
import { Bots } from "../../workspaces/bots/bots.ts";
import { workspaceOfBot } from "../../workspaces/workspace-reference.ts";

import { defineOperation } from "../operation.ts";

/**
 * Proves changes to bot reach and desktop use under the workspace's lock.
 */
export const update = defineOperation(botsContracts["bots.update"], (principal, input) =>
	Effect.gen(function* () {
		const withdrawals = yield* Turns.ApprovalWithdrawals.Service;
		const bots = yield* Bots.Service;
		if (input.changes.visibility === undefined && input.changes.usesComputer === undefined) {
			return yield* named(principal, input.botId, (principal, bot) =>
				Effect.flatMap(proveCanManageBot(principal, bot), (canManage) =>
					bots.update(canManage, input.changes),
				),
			);
		}
		const workspaceId = yield* workspaceOfBot(input.botId);
		if (workspaceId === undefined) return yield* new ResourceHidden({ resource: "bot" });
		return yield* underWorkspaceLock(principal, workspaceId, (lock) =>
			named(input.botId, (bot) =>
				Effect.gen(function* () {
					const canManage = yield* proveCanManageBot(lock.principal, bot);
					const canChangeReach = yield* proveCanChangeBotReach(lock, canManage);
					return yield* bots
						.update(canChangeReach, input.changes)
						.pipe(
							Effect.tap(() =>
								input.changes.visibility === undefined
									? Effect.void
									: withdrawals.afterReachChange(lock),
							),
						);
				}),
			),
		);
	}),
);
