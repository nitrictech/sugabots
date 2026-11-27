import { botsContracts } from "@sugabots/contracts/operations/bots";
import { Effect } from "effect";
import { named } from "../../proofs/proof.ts";
import { proveReachesBot } from "../../proofs/reaches-bot.ts";
import { Bots } from "../../workspaces/bots/bots.ts";
import { defineOperation } from "../operation.ts";

export const listMembers = defineOperation(botsContracts["bots.listMembers"], (principal, input) =>
	Effect.gen(function* () {
		const bots = yield* Bots.Service;
		return yield* named(principal, input.botId, (principal, bot) =>
			Effect.flatMap(proveReachesBot(principal, bot), bots.members),
		);
	}),
);
