import { chatsContracts } from "@sugabots/contracts/operations/chats";
import { Effect } from "effect";
import { Turns } from "../../chats/turns/turns.ts";
import { proveIsMember } from "../../proofs/is-member.ts";
import { named } from "../../proofs/proof.ts";
import { proveReachesChat } from "../../proofs/reaches-chat.ts";
import { proveCanInterrupt } from "../../proofs/turn-control.ts";
import { defineOperation } from "../operation.ts";

/** A member stopping a bot's turn in a chat they reach. */
export const interruptTurn = defineOperation(
	chatsContracts["chats.interruptTurn"],
	(principal, input) =>
		Effect.gen(function* () {
			const controls = yield* Turns.Controls;
			return yield* named(principal, input.chatId, input.turnId, (principal, chat, turn) =>
				Effect.gen(function* () {
					const isMember = yield* proveIsMember(principal);
					const reach = yield* proveReachesChat(principal, chat);
					const canInterrupt = yield* proveCanInterrupt(isMember, reach, turn);
					return yield* controls.interrupt(canInterrupt);
				}),
			);
		}),
);
