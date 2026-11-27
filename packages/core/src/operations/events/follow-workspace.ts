import { workspaceStream } from "@sugabots/contracts";
import { eventsContracts } from "@sugabots/contracts/operations/events";
import { Effect } from "effect";
import { proveInWorkspace } from "../../proofs/in-workspace.ts";
import { named } from "../../proofs/proof.ts";
import { proveReachSet } from "../../proofs/reach-set.ts";
import { Streams } from "../../streams/streams.ts";
import { workspaceIdOf } from "../../workspaces/workspace-reference.ts";
import { defineLongRunningOperation } from "../operation.ts";
import { followerOf } from "./following.ts";

export const followWorkspace = defineLongRunningOperation(
	eventsContracts["events.followWorkspace"],
	(principal, input) =>
		Effect.gen(function* () {
			const streams = yield* Streams.Service;
			const follower = yield* followerOf(principal);
			const workspaceId = yield* workspaceIdOf(input.workspace);
			return yield* streams.follow({
				principal: follower,
				stream: workspaceStream(workspaceId),
				since: input.since,
				workspace: workspaceId,
				// Named afresh each time it proves again, so what it hears is never
				// decided by a proof older than the last change of reach.
				prove: named(principal, workspaceId, (principal, workspace) =>
					Effect.flatMap(proveInWorkspace(principal, workspace), (inWorkspace) =>
						streams.hearingIn(proveReachSet(inWorkspace)),
					),
				),
			});
		}),
);
