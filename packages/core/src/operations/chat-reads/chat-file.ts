import { chatReadsContracts } from "@sugabots/contracts/operations/chat-reads";
import { Effect } from "effect";
import { ChatFiles } from "../../chats/chats/chat-files.ts";
import { named } from "../../proofs/proof.ts";
import { proveReachesChat } from "../../proofs/reaches-chat.ts";
import { defineOperation } from "../operation.ts";

export const chatFile = defineOperation(chatReadsContracts["chats.file"], (principal, input) =>
	Effect.gen(function* () {
		const files = yield* ChatFiles.Service;
		return yield* named(principal, input.chatId, (principal, chat) =>
			Effect.flatMap(proveReachesChat(principal, chat), (reach) => files.read(reach, input.fileId)),
		);
	}),
);
