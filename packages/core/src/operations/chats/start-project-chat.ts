import { chatsContracts } from "@sugabots/contracts/operations/chats";
import { Effect } from "effect";
import { Chats } from "../../chats/chats/chats.ts";
import { proveIsMember } from "../../proofs/is-member.ts";
import { named } from "../../proofs/proof.ts";
import { proveReachesProject } from "../../proofs/reaches-project.ts";
import { defineOperation } from "../operation.ts";

export const startProjectChat = defineOperation(
	chatsContracts["chats.startProjectChat"],
	(principal, input) =>
		Effect.gen(function* () {
			const chats = yield* Chats.Service;
			return yield* named(principal, input.projectId, (principal, project) =>
				Effect.gen(function* () {
					const isMember = yield* proveIsMember(principal);
					// A member who reaches a project takes part in its chats.
					const reach = yield* proveReachesProject(principal, project);
					return yield* chats.startProjectChat(isMember, reach, {
						messageId: input.id,
						content: input.message,
					});
				}),
			);
		}),
);
