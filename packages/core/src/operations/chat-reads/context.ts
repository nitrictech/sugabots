import { chatReadsContracts } from "@sugabots/contracts/operations/chat-reads";
import { Effect } from "effect";
import { ChatDetailsView } from "../../chats/chat-details-view.ts";
import { named } from "../../proofs/proof.ts";
import { proveReachesChat } from "../../proofs/reaches-chat.ts";
import { defineOperation } from "../operation.ts";

export const context = defineOperation(chatReadsContracts["chats.context"], (principal, input) =>
	Effect.gen(function* () {
		const details = yield* ChatDetailsView.Service;
		return yield* named(principal, input.chatId, (principal, chat) =>
			Effect.flatMap(proveReachesChat(principal, chat), details.context),
		);
	}),
);
