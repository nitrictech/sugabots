import { ResourceHidden } from "@sugabots/contracts/errors/proofs";
import { chatReadsContracts } from "@sugabots/contracts/operations/chat-reads";
import { Effect } from "effect";
import { lookUpWorkspaceRole } from "../../chats/chats/workspace-role.ts";
import { approvalRule, proveApproved } from "../../proofs/approved.ts";
import { named } from "../../proofs/proof.ts";
import { proveReachesChat } from "../../proofs/reaches-chat.ts";
import { defineOperation } from "../operation.ts";

export const workspaceRole = defineOperation(
	chatReadsContracts["chats.workspaceRole"],
	(principal, input, call) => {
		if (principal._tag !== "BotForAsker" && principal._tag !== "AutomationRun") {
			return new ResourceHidden({ resource: "chat" });
		}
		return named(principal, principal.chat, call, (principal, chat, call) =>
			Effect.gen(function* () {
				const reach = yield* proveReachesChat(principal, chat);
				const approved = yield* proveApproved(
					principal,
					call,
					approvalRule("chats.workspaceRole"),
					input,
				);
				return yield* lookUpWorkspaceRole(reach, input.member, approved);
			}),
		);
	},
);
