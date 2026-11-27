import { chatReadsContracts } from "@sugabots/contracts/operations/chat-reads";
import { Effect } from "effect";
import { ChatDetailsView } from "../../chats/chat-details-view.ts";
import { named } from "../../proofs/proof.ts";
import { proveReachesChat } from "../../proofs/reaches-chat.ts";
import { defineOperation } from "../operation.ts";

export const get = defineOperation(chatReadsContracts["chats.get"], (principal, input) =>
	Effect.gen(function* () {
		const details = yield* ChatDetailsView.Service;
		const { chatId, ...history } = input;
		return yield* named(principal, chatId, (principal, chat) =>
			Effect.flatMap(proveReachesChat(principal, chat), (reach) => details.get(reach, history)),
		);
	}),
);
