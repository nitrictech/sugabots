import { chatsContracts } from "@sugabots/contracts/operations/chats";
import { Effect } from "effect";
import { Chats } from "../../chats/chats/chats.ts";
import { proveCanManageChats } from "../../proofs/chat-permissions.ts";
import { named } from "../../proofs/proof.ts";
import { proveReachesChat } from "../../proofs/reaches-chat.ts";
import { defineOperation } from "../operation.ts";

export const renameChat = defineOperation(chatsContracts["chats.renameChat"], (principal, input) =>
	Effect.gen(function* () {
		const chats = yield* Chats.Service;
		return yield* named(principal, input.chatId, (principal, chat) =>
			Effect.gen(function* () {
				const reach = yield* proveReachesChat(principal, chat);
				const canManage = yield* proveCanManageChats(reach);
				return yield* chats.renameChat(reach, input.name, canManage);
			}),
		);
	}),
);
