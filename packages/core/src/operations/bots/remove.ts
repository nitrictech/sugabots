import { botsContracts } from "@sugabots/contracts/operations/bots";
import { Effect } from "effect";
import { proveCanDeleteBot } from "../../proofs/bot-permissions.ts";
import { proveCanManageBot } from "../../proofs/can-manage-bot.ts";
import { proveCanRestrictBot } from "../../proofs/can-restrict-bot.ts";
import { named } from "../../proofs/proof.ts";
import { Bots } from "../../workspaces/bots/bots.ts";
import { defineOperation } from "../operation.ts";

export const remove = defineOperation(botsContracts["bots.remove"], (principal, input) =>
	Effect.gen(function* () {
		const bots = yield* Bots.Service;
		return yield* named(principal, input.botId, (principal, bot) =>
			Effect.gen(function* () {
				// An admin deletes a bot they don't manage, such as a personal bot, by restricting it.
				const authority = yield* proveCanManageBot(principal, bot).pipe(
					Effect.catch(() => proveCanRestrictBot(principal, bot)),
				);
				return yield* bots.remove(yield* proveCanDeleteBot(authority));
			}),
		);
	}),
);
