import { ResourceHidden } from "@sugabots/contracts/errors/proofs";
import { chatReadsContracts } from "@sugabots/contracts/operations/chat-reads";
import { Effect } from "effect";
import { ChatFiles } from "../../chats/chats/chat-files.ts";
import { approvalRule, proveApproved } from "../../proofs/approved.ts";
import { named } from "../../proofs/proof.ts";
import { proveReachesFile, proveReachesFileInChat } from "../../proofs/reaches-file.ts";
import { defineOperation } from "../operation.ts";

export const readChatFile = defineOperation(
	chatReadsContracts["chats.readChatFile"],
	(principal, input, call) => {
		if (principal._tag !== "BotForAsker" && principal._tag !== "AutomationRun") {
			return new ResourceHidden({ resource: "file" });
		}
		const { file: fileId, chat: chatId, ...read } = input;
		return named(principal, fileId, call, (principal, file, call) =>
			Effect.gen(function* () {
				const files = yield* ChatFiles.Service;
				const reach = yield* chatId === undefined
					? proveReachesFile(principal, file)
					: named(chatId, (expectedChat) => proveReachesFileInChat(principal, expectedChat, file));
				const approved = yield* proveApproved(
					principal,
					call,
					approvalRule("chats.readChatFile"),
					input,
				);
				return yield* files.readForTurn(reach, read, approved);
			}),
		);
	},
);
