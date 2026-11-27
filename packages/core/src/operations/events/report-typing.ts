import { ResourceHidden } from "@sugabots/contracts/errors/proofs";
import { eventsContracts } from "@sugabots/contracts/operations/events";
import { Effect } from "effect";
import { proveIsMember } from "../../proofs/is-member.ts";
import { proveCanTakePart } from "../../proofs/project-permissions.ts";
import { named } from "../../proofs/proof.ts";
import { proveReachesChat } from "../../proofs/reaches-chat.ts";
import { Streams } from "../../streams/streams.ts";
import { defineOperation } from "../operation.ts";

export const reportTyping = defineOperation(
	eventsContracts["events.reportTyping"],
	(principal, input) =>
		Effect.gen(function* () {
			const streams = yield* Streams.Service;
			// Named by the id the chat is stored under, which its watchers follow it by.
			const found = yield* streams.chatOf(input.chatId);
			if (found === undefined) return yield* new ResourceHidden({ resource: "chat" });
			return yield* named(principal, found.id, (principal, chat) =>
				Effect.gen(function* () {
					const isMember = yield* proveIsMember(principal);
					const canTakePart = yield* proveCanTakePart(yield* proveReachesChat(principal, chat));
					return yield* streams.reportTyping(canTakePart, isMember);
				}),
			);
		}),
);
