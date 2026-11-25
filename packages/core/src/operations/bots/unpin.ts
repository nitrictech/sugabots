import { botsContracts } from "@sugabots/contracts/operations/bots";
import { Effect } from "effect";
import { proveActsForMember } from "../../proofs/acts-for-member.ts";
import { approvalRule, proveApproved } from "../../proofs/approved.ts";
import { named } from "../../proofs/proof.ts";
import { proveReachesBot } from "../../proofs/reaches-bot.ts";
import { Bots } from "../../workspaces/bots/bots.ts";
import { defineOperation } from "../operation.ts";

export const unpin = defineOperation(botsContracts["bots.unpin"], (principal, input, call) =>
	Effect.gen(function* () {
		const bots = yield* Bots.Service;
		return yield* named(principal, input.botId, call, (principal, bot, call) =>
			Effect.gen(function* () {
				const reach = yield* proveReachesBot(principal, bot);
				const forMember = yield* proveActsForMember(principal);
				const approved = yield* proveApproved(principal, call, approvalRule("bots.unpin"), input);
				return yield* bots.setPinned(forMember, reach, false, approved);
			}),
		);
	}),
);
