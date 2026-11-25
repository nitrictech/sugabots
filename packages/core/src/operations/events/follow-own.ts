import { memberStream } from "@sugabots/contracts";
import { eventsContracts } from "@sugabots/contracts/operations/events";
import { Effect } from "effect";
import { proveIsMember } from "../../proofs/is-member.ts";
import { named } from "../../proofs/proof.ts";
import { Streams } from "../../streams/streams.ts";
import { defineLongRunningOperation } from "../operation.ts";
import { followerOf } from "./following.ts";

export const followOwn = defineLongRunningOperation(
	eventsContracts["events.followOwn"],
	(principal, input) =>
		Effect.gen(function* () {
			const streams = yield* Streams.Service;
			const follower = yield* followerOf(principal);
			return yield* streams.follow({
				principal: follower,
				stream: memberStream(follower.member),
				since: input.since,
				workspace: undefined,
				prove: named(principal, (principal) =>
					Effect.map(proveIsMember(principal), streams.hearingOwn),
				),
			});
		}),
);
