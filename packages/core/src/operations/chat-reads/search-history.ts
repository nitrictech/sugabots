import { ResourceHidden } from "@sugabots/contracts/errors/proofs";
import { chatReadsContracts } from "@sugabots/contracts/operations/chat-reads";
import { Effect } from "effect";
import { searchHistory as searchMessages } from "../../chats/chats/search-history.ts";
import { approvalRule, proveApproved } from "../../proofs/approved.ts";
import { proveInWorkspace } from "../../proofs/in-workspace.ts";
import { named } from "../../proofs/proof.ts";
import { proveReachSet } from "../../proofs/reach-set.ts";
import { proveReachesChat } from "../../proofs/reaches-chat.ts";
import { defineOperation } from "../operation.ts";

export const searchHistory = defineOperation(
	chatReadsContracts["chats.searchHistory"],
	(principal, input, call) => {
		if (principal._tag !== "BotForAsker" && principal._tag !== "AutomationRun") {
			return new ResourceHidden({ resource: "chat" });
		}
		const { chat } = input;
		const targetChat = chat === "all" ? principal.chat : (chat ?? principal.chat);
		return named(
			principal,
			targetChat,
			principal.workspace,
			call,
			input,
			(principal, target, workspace, call, approvedInput) =>
				Effect.gen(function* () {
					const chatReach = yield* proveReachesChat(principal, target);
					const rule = approvalRule("chats.searchHistory");
					if (chat === "all") {
						const reach = proveReachSet(yield* proveInWorkspace(principal, workspace));
						const approval = yield* proveApproved(principal, call, rule, approvedInput, workspace);
						return yield* searchMessages({ kind: "all", reach }, approval);
					}
					const approval = yield* proveApproved(principal, call, rule, approvedInput, target);
					return yield* searchMessages({ kind: "chat", reach: chatReach }, approval);
				}),
		);
	},
);
