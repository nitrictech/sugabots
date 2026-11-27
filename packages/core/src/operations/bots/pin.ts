import { botsContracts } from "@sugabots/contracts/operations/bots";
import { Effect } from "effect";
import { proveActsForMember } from "../../proofs/acts-for-member.ts";
import { approvalRule, proveApproved } from "../../proofs/approved.ts";
import { named } from "../../proofs/proof.ts";
import { proveReachesBot } from "../../proofs/reaches-bot.ts";
import { writingUnderWorkspaceShare } from "../../proofs/workspace-lock.ts";
import { Bots } from "../../workspaces/bots/bots.ts";
import { workspaceOfBot } from "../../workspaces/workspace-reference.ts";
import { defineOperation } from "../operation.ts";

export const pin = defineOperation(botsContracts["bots.pin"], (principal, input, call) =>
	Effect.gen(function* () {
		const bots = yield* Bots.Service;
		return yield* named(
			principal,
			input.botId,
			call,
			input,
			(principal, bot, call, approvedInput) =>
				// Reach to the bot is proved in the pin's transaction, under the
				// workspace's lock shared, so a member taken out of a private bot
				// meanwhile doesn't pin it.
				writingUnderWorkspaceShare(
					workspaceOfBot(bot.value),
					"bot",
					Effect.gen(function* () {
						const reach = yield* proveReachesBot(principal, bot);
						const forMember = yield* proveActsForMember(principal);
						const approved = yield* proveApproved(
							principal,
							call,
							approvalRule("bots.pin"),
							approvedInput,
							bot,
						);
						return yield* bots.setPinned(forMember, reach, true, approved);
					}),
				),
		);
	}),
);
