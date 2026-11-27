import { botsContracts } from "@sugabots/contracts/operations/bots";
import { Effect } from "effect";
import { Turns } from "../../chats/turns/turns.ts";
import { proveCanDeleteBot } from "../../proofs/bot-permissions.ts";
import { proveCanManageBot } from "../../proofs/can-manage-bot.ts";
import { proveCanRestrictBot } from "../../proofs/can-restrict-bot.ts";
import { named } from "../../proofs/proof.ts";
import { Bots } from "../../workspaces/bots/bots.ts";

import { finishDeletion } from "../finish-deletion.ts";
import { defineOperation } from "../operation.ts";
import { underBotsLock } from "./locking.ts";

/** Deleting a bot changes who reaches what, so it is proved and made under its workspace's lock. */
export const remove = defineOperation(botsContracts["bots.remove"], (principal, input) =>
	Effect.gen(function* () {
		const withdrawals = yield* Turns.ApprovalWithdrawals.Service;
		const bots = yield* Bots.Service;
		const { workspaceId, projectId } = yield* underBotsLock(principal, input.botId, (lock) =>
			named(input.botId, (bot) =>
				Effect.gen(function* () {
					// An admin deletes a bot they don't manage, such as a personal bot, by restricting it.
					const authority = yield* proveCanManageBot(lock.principal, bot).pipe(
						Effect.catch(() => proveCanRestrictBot(lock.principal, bot)),
					);
					const projectId = yield* bots.beginRemoval(yield* proveCanDeleteBot(lock, authority));
					return { workspaceId: lock.workspace.value, projectId };
				}),
			).pipe(Effect.tap(() => withdrawals.afterDeletionStarts(lock))),
		);
		yield* finishDeletion(principal, workspaceId, { kind: "project", id: projectId });
	}),
);
