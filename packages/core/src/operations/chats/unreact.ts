import { chatsContracts } from "@sugabots/contracts/operations/chats";
import { Effect } from "effect";
import { Reactions } from "../../chats/reactions/reactions.ts";
import { proveIsMember } from "../../proofs/is-member.ts";
import { named } from "../../proofs/proof.ts";
import { proveReachesMessage } from "../../proofs/reaches-message.ts";
import { defineOperation } from "../operation.ts";

export const unreact = defineOperation(chatsContracts["chats.unreact"], (principal, input) =>
	Effect.gen(function* () {
		const reactions = yield* Reactions.Service;
		return yield* named(principal, input.messageId, (principal, message) =>
			Effect.gen(function* () {
				const isMember = yield* proveIsMember(principal);
				const reach = yield* proveReachesMessage(principal, message);
				return yield* reactions.remove(isMember, reach, input.emoji);
			}),
		);
	}),
);
