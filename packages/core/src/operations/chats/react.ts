import { chatsContracts } from "@sugabots/contracts/operations/chats";
import { Effect } from "effect";
import { Reactions } from "../../chats/reactions/reactions.ts";
import { proveIsMember } from "../../proofs/is-member.ts";
import { named } from "../../proofs/proof.ts";
import { proveReachesMessage } from "../../proofs/reaches-message.ts";
import { defineOperation } from "../operation.ts";

export const react = defineOperation(chatsContracts["chats.react"], (principal, input) =>
	Effect.gen(function* () {
		const reactions = yield* Reactions.Service;
		return yield* named(principal, input.messageId, (principal, message) =>
			Effect.gen(function* () {
				const isMember = yield* proveIsMember(principal);
				// A member who reaches a message's chat takes part in it.
				const reach = yield* proveReachesMessage(principal, message);
				return yield* reactions.add(isMember, reach, input.emoji);
			}),
		);
	}),
);
