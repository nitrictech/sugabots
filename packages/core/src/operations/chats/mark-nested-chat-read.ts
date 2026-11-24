import { chatsContracts } from "@sugabots/contracts/operations/chats";
import { Effect } from "effect";
import { Chats } from "../../chats/chats/chats.ts";
import { proveIsMember } from "../../proofs/is-member.ts";
import { named } from "../../proofs/proof.ts";
import { proveReachesChat } from "../../proofs/reaches-chat.ts";
import { defineOperation } from "../operation.ts";

export const markNestedChatRead = defineOperation(
	chatsContracts["chats.markNestedChatRead"],
	(principal, input) =>
		Effect.gen(function* () {
			const chats = yield* Chats.Service;
			return yield* named(principal, input.chatId, (principal, chat) =>
				Effect.gen(function* () {
					const isMember = yield* proveIsMember(principal);
					return yield* chats.markNestedChatRead(
						isMember,
						yield* proveReachesChat(principal, chat),
					);
				}),
			);
		}),
);
