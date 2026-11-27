import { chatsContracts } from "@sugabots/contracts/operations/chats";
import { Effect } from "effect";
import { Chats } from "../../chats/chats/chats.ts";
import { proveIsMember } from "../../proofs/is-member.ts";
import { proveCanTakePart } from "../../proofs/project-permissions.ts";
import { named } from "../../proofs/proof.ts";
import { proveReachesChat } from "../../proofs/reaches-chat.ts";
import { writingUnderWorkspaceShare } from "../../proofs/workspace-lock.ts";
import { workspaceOfChat } from "../../workspaces/workspace-reference.ts";
import { defineOperation } from "../operation.ts";

export const send = defineOperation(chatsContracts["chats.send"], (principal, input) =>
	Effect.gen(function* () {
		const chats = yield* Chats.Service;
		// The post commits under the workspace's lock shared, which the proof
		// took, so it can't commit after the sender's removal has.
		return yield* named(principal, input.chatId, (principal, chat) =>
			writingUnderWorkspaceShare(
				workspaceOfChat(chat.value),
				"chat",
				Effect.gen(function* () {
					const isMember = yield* proveIsMember(principal);
					const canTakePart = yield* proveCanTakePart(yield* proveReachesChat(principal, chat));
					return yield* chats.post(isMember, canTakePart, {
						retryKey: input.retryKey,
						content: input.message,
						attachments: input.attachments,
						replyTo: input.replyTo,
					});
				}),
			),
		);
	}),
);
