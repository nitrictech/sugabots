import { chatsContracts } from "@sugabots/contracts/operations/chats";
import { Effect } from "effect";
import { ChatFiles } from "../../chats/chats/chat-files.ts";
import { proveIsMember } from "../../proofs/is-member.ts";
import { proveCanTakePart } from "../../proofs/project-permissions.ts";
import { named } from "../../proofs/proof.ts";
import { proveReachesChat } from "../../proofs/reaches-chat.ts";
import { defineOperation } from "../operation.ts";

export const uploadFile = defineOperation(chatsContracts["chats.uploadFile"], (principal, input) =>
	Effect.gen(function* () {
		const files = yield* ChatFiles.Service;
		return yield* named(principal, input.chatId, (principal, chat) =>
			Effect.gen(function* () {
				const isMember = yield* proveIsMember(principal);
				const canTakePart = yield* proveCanTakePart(yield* proveReachesChat(principal, chat));
				return yield* files.upload(isMember, canTakePart, {
					name: input.name,
					type: input.type,
					stream: input.content,
				});
			}),
		);
	}),
);
