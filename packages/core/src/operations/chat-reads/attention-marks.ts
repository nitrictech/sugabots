import { chatReadsContracts } from "@sugabots/contracts/operations/chat-reads";
import { Effect } from "effect";
import { ChatView } from "../../chats/chats/chat-view.ts";
import { proveReachSet } from "../../proofs/reach-set.ts";
import { defineOperation } from "../operation.ts";
import { readingWorkspace } from "../workspace-openings.ts";

export const attentionMarks = defineOperation(
	chatReadsContracts["chats.attentionMarks"],
	(principal, input) =>
		Effect.gen(function* () {
			const view = yield* ChatView.Service;
			return yield* readingWorkspace(principal, input.workspace, (canRead) =>
				view.attentionMarks(canRead, proveReachSet(canRead.inWorkspace)),
			);
		}),
);
