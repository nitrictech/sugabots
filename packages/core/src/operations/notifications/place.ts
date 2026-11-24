import type { NotificationPlaceKind } from "@sugabots/contracts";
import { Effect } from "effect";
import type { PlaceReached } from "../../notifications/notifications.ts";
import type { Principal } from "../../principal.ts";
import type { Named } from "../../proofs/proof.ts";
import { proveReachesBot } from "../../proofs/reaches-bot.ts";
import { proveReachesProject } from "../../proofs/reaches-project.ts";

/** That P reaches the project or bot `placeId` names, as `kind` says it is. */
export const provePlaceReached = <P, X>(
	principal: Named<P, Principal>,
	placeId: Named<X, string>,
	kind: NotificationPlaceKind,
) =>
	Effect.gen(function* () {
		const reached: PlaceReached<P, X> =
			kind === "project"
				? yield* proveReachesProject(principal, placeId)
				: yield* proveReachesBot(principal, placeId);
		return reached;
	});
