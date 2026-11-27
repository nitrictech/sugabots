import { botsContracts } from "@sugabots/contracts/operations/bots";
import { Effect } from "effect";
import { proveCanChangeBotMembers } from "../../proofs/bot-permissions.ts";
import { named } from "../../proofs/proof.ts";
import { proveReachesBot } from "../../proofs/reaches-bot.ts";
import { Bots } from "../../workspaces/bots/bots.ts";
import { defineOperation } from "../operation.ts";
import { underBotsLock } from "./locking.ts";

export const addMember = defineOperation(botsContracts["bots.addMember"], (principal, input) =>
	Effect.gen(function* () {
		const bots = yield* Bots.Service;
		return yield* underBotsLock(principal, input.botId, (lock) =>
			named(input.botId, input.memberId, (bot, member) =>
				Effect.gen(function* () {
					const canChange = yield* proveCanChangeBotMembers(
						lock,
						yield* proveReachesBot(lock.principal, bot),
					);
					return yield* bots.addMember(canChange, member);
				}),
			),
		);
	}),
);
