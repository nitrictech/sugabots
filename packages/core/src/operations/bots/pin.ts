import { botsContracts } from "@sugabots/contracts/operations/bots";
import { Effect } from "effect";
import { proveIsMember } from "../../proofs/is-member.ts";
import { named } from "../../proofs/proof.ts";
import { proveReachesBot } from "../../proofs/reaches-bot.ts";
import { Bots } from "../../workspaces/bots/bots.ts";
import { defineOperation } from "../operation.ts";

export const pin = defineOperation(botsContracts["bots.pin"], (principal, input) =>
	Effect.gen(function* () {
		const bots = yield* Bots.Service;
		return yield* named(principal, input.botId, (principal, bot) =>
			Effect.gen(function* () {
				const reach = yield* proveReachesBot(principal, bot);
				return yield* bots.setPinned(yield* proveIsMember(principal), reach, true);
			}),
		);
	}),
);
