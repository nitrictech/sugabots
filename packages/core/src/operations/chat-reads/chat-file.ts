import { chatReadsContracts } from "@sugabots/contracts/operations/chat-reads";
import { Effect } from "effect";
import { ChatFiles } from "../../chats/chats/chat-files.ts";
import { named } from "../../proofs/proof.ts";
import { proveReachesMessageFile } from "../../proofs/reaches-file.ts";
import { defineOperation } from "../operation.ts";

export const chatFile = defineOperation(chatReadsContracts["chats.file"], (principal, input) =>
	Effect.gen(function* () {
		const files = yield* ChatFiles.Service;
		return yield* named(principal, input.chatId, input.fileId, (principal, chat, file) =>
			Effect.flatMap(proveReachesMessageFile(principal, chat, file), (reach) =>
				files.read(file, reach),
			),
		);
	}),
);
