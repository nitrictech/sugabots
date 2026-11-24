import { chatReadsContracts } from "@sugabots/contracts/operations/chat-reads";
import { Effect } from "effect";
import { ChatView } from "../../chats/chats/chat-view.ts";
import { named } from "../../proofs/proof.ts";
import { proveReachesProject } from "../../proofs/reaches-project.ts";
import { defineOperation } from "../operation.ts";

export const projectChats = defineOperation(
	chatReadsContracts["chats.projectChats"],
	(principal, input) =>
		Effect.gen(function* () {
			const view = yield* ChatView.Service;
			return yield* named(principal, input.projectId, (principal, project) =>
				Effect.flatMap(proveReachesProject(principal, project), view.chats),
			);
		}),
);
