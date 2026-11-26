import { chatReadsContracts } from "@sugabots/contracts/operations/chat-reads";
import { Effect } from "effect";
import { ChatView } from "../../chats/chats/chat-view.ts";
import { proveReachSet } from "../../proofs/reach-set.ts";
import { defineOperation } from "../operation.ts";
import { readingWorkspace } from "../workspace-openings.ts";

export const approvals = defineOperation(
	chatReadsContracts["chats.approvals"],
	(principal, input) =>
		Effect.gen(function* () {
			const view = yield* ChatView.Service;
			return yield* readingWorkspace(principal, input.workspace, (canRead) =>
				view.approvals(canRead, proveReachSet(canRead.inWorkspace)),
			);
		}),
);
