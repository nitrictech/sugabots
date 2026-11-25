import { chatStream } from "@sugabots/contracts";
import { ResourceHidden } from "@sugabots/contracts/errors/proofs";
import { eventsContracts } from "@sugabots/contracts/operations/events";
import { Effect } from "effect";
import { named } from "../../proofs/proof.ts";
import { proveReachesChat } from "../../proofs/reaches-chat.ts";
import { Streams } from "../../streams/streams.ts";
import { defineLongRunningOperation } from "../operation.ts";
import { followerOf } from "./following.ts";

export const followChat = defineLongRunningOperation(
	eventsContracts["events.followChat"],
	(principal, input) =>
		Effect.gen(function* () {
			const streams = yield* Streams.Service;
			const follower = yield* followerOf(principal);
			// Followed, and named, by the id the chat is stored under, which its events are published with.
			const found = yield* streams.chatOf(input.chatId);
			if (found === undefined) return yield* new ResourceHidden({ resource: "chat" });
			return yield* streams.follow({
				principal: follower,
				stream: chatStream(found.id),
				since: input.since,
				workspace: found.workspace,
				prove: named(principal, found.id, (principal, chat) =>
					Effect.map(proveReachesChat(principal, chat), streams.hearingChat),
				),
			});
		}),
);
