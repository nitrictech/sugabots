import { notificationsContracts } from "@sugabots/contracts/operations/notifications";
import { DateTime, Effect } from "effect";
import { Notifications } from "../../notifications/notifications.ts";
import { proveIsMember } from "../../proofs/is-member.ts";
import { named } from "../../proofs/proof.ts";
import { defineOperation } from "../operation.ts";
import { provePlaceReached } from "./place.ts";

export const mute = defineOperation(
	notificationsContracts["notifications.mute"],
	(principal, input) =>
		Effect.gen(function* () {
			const notifications = yield* Notifications.Service;
			const { until: untilAt, ...place } = input;
			const until = untilAt === null ? null : DateTime.toDate(DateTime.makeUnsafe(untilAt));
			const now = yield* DateTime.nowAsDate;
			return yield* named(principal, place.id, (principal, placeId) =>
				Effect.gen(function* () {
					const isMember = yield* proveIsMember(principal);
					// Ending a mute, as a time already passed does, removes only the member's own choice.
					if (until === null || until <= now) return yield* notifications.unmute(isMember, place);
					const reached = yield* provePlaceReached(principal, placeId, place.kind);
					return yield* notifications.mute(isMember, reached, until);
				}),
			);
		}),
);
