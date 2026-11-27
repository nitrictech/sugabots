import { chatsContracts } from "@sugabots/contracts/operations/chats";
import { Effect } from "effect";
import { Chats } from "../../chats/chats/chats.ts";
import { approvalRule, proveApproved } from "../../proofs/approved.ts";
import { proveCanChangeChat } from "../../proofs/project-permissions.ts";
import { named } from "../../proofs/proof.ts";
import { proveReachesChat } from "../../proofs/reaches-chat.ts";
import { defineOperation } from "../operation.ts";

export const setResolved = defineOperation(
	chatsContracts["chats.setResolved"],
	(principal, input, call) =>
		Effect.gen(function* () {
			const chats = yield* Chats.Service;
			return yield* named(
				principal,
				input.chatId,
				call,
				input,
				(principal, chat, call, approvedInput) =>
					Effect.gen(function* () {
						const reach = yield* proveReachesChat(principal, chat);
						const canChange = yield* proveCanChangeChat(reach);
						const approved = yield* proveApproved(
							principal,
							call,
							approvalRule("chats.setResolved"),
							approvedInput,
							chat,
						);
						return yield* chats.setResolved(reach, canChange, approved);
					}),
			);
		}),
);
