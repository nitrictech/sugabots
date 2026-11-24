import { botsContracts } from "@sugabots/contracts/operations/bots";
import { Effect } from "effect";
import { proveCanManageBot } from "../../proofs/can-manage-bot.ts";
import { named } from "../../proofs/proof.ts";
import { Bots } from "../../workspaces/bots/bots.ts";
import { defineOperation } from "../operation.ts";

export const update = defineOperation(botsContracts["bots.update"], (principal, input) =>
	Effect.gen(function* () {
		const bots = yield* Bots.Service;
		return yield* named(principal, input.botId, (principal, bot) =>
			Effect.flatMap(proveCanManageBot(principal, bot), (canManage) =>
				bots.update(canManage, input.changes),
			),
		);
	}),
);
