import { chatReadsContracts } from "@sugabots/contracts/operations/chat-reads";
import { Effect } from "effect";
import { ChatView } from "../../chats/chats/chat-view.ts";
import { named } from "../../proofs/proof.ts";
import { proveReachesChat } from "../../proofs/reaches-chat.ts";
import { readingUnderWorkspaceShare } from "../../proofs/workspace-lock.ts";
import { workspaceOfChat } from "../../workspaces/workspace-reference.ts";
import { defineOperation } from "../operation.ts";

export const messages = defineOperation(chatReadsContracts["chats.messages"], (principal, input) =>
	Effect.gen(function* () {
		const view = yield* ChatView.Service;
		const { chatId, ...page } = input;
		return yield* named(principal, chatId, (principal, chat) =>
			readingUnderWorkspaceShare(
				workspaceOfChat(chat.value),
				"chat",
				Effect.flatMap(proveReachesChat(principal, chat), (reach) => view.messages(reach, page)),
			),
		);
	}),
);
