import { ResourceHidden } from "@sugabots/contracts/errors/proofs";
import { chatReadsContracts } from "@sugabots/contracts/operations/chat-reads";
import { Effect } from "effect";
import { readDocsPage } from "../../chats/chats/read-docs.ts";
import { approvalRule, proveApproved } from "../../proofs/approved.ts";
import { named } from "../../proofs/proof.ts";
import { proveReachesChat } from "../../proofs/reaches-chat.ts";
import { defineOperation } from "../operation.ts";

export const readDocs = defineOperation(
	chatReadsContracts["chats.readDocs"],
	(principal, input, call) => {
		if (principal._tag !== "BotForAsker" && principal._tag !== "AutomationRun") {
			return new ResourceHidden({ resource: "chat" });
		}
		return named(principal, principal.chat, call, (principal, chat, call) =>
			Effect.gen(function* () {
				yield* proveReachesChat(principal, chat);
				yield* proveApproved(principal, call, approvalRule("chats.readDocs"), input);
				return readDocsPage(input);
			}),
		);
	},
);
