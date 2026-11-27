import { chatsContracts } from "@sugabots/contracts/operations/chats";
import { Effect } from "effect";
import { ChatFiles } from "../../chats/chats/chat-files.ts";
import { proveIsMember } from "../../proofs/is-member.ts";
import { named } from "../../proofs/proof.ts";
import { proveOwnsUnsentAttachment } from "../../proofs/reaches-file.ts";
import { defineOperation } from "../operation.ts";

export const removeFile = defineOperation(chatsContracts["chats.removeFile"], (principal, input) =>
	Effect.gen(function* () {
		const files = yield* ChatFiles.Service;
		return yield* named(principal, input.chatId, input.fileId, (principal, chat, file) =>
			Effect.gen(function* () {
				const isMember = yield* proveIsMember(principal);
				const reach = yield* proveOwnsUnsentAttachment(isMember, chat, file);
				return yield* files.removeUnsentAttachment(file, reach);
			}),
		);
	}),
);
