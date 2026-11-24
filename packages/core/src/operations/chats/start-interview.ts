import { chatsContracts } from "@sugabots/contracts/operations/chats";
import { Effect } from "effect";
import { Chats } from "../../chats/chats/chats.ts";
import { proveCanManageBot } from "../../proofs/can-manage-bot.ts";
import { proveIsMember } from "../../proofs/is-member.ts";
import { named } from "../../proofs/proof.ts";
import { defineOperation } from "../operation.ts";

export const startInterview = defineOperation(
	chatsContracts["chats.startInterview"],
	(principal, input) =>
		Effect.gen(function* () {
			const chats = yield* Chats.Service;
			return yield* named(principal, input.botId, (principal, bot) =>
				Effect.gen(function* () {
					const isMember = yield* proveIsMember(principal);
					const canManage = yield* proveCanManageBot(principal, bot);
					return yield* chats.startInterview(isMember, canManage);
				}),
			);
		}),
);
