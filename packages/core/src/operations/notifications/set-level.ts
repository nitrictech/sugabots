import { notificationsContracts } from "@sugabots/contracts/operations/notifications";
import { Effect } from "effect";
import { Notifications } from "../../notifications/notifications.ts";
import { proveIsMember } from "../../proofs/is-member.ts";
import { named } from "../../proofs/proof.ts";
import { defineOperation } from "../operation.ts";
import { provePlaceReached } from "./place.ts";

export const setLevel = defineOperation(
	notificationsContracts["notifications.setLevel"],
	(principal, input) =>
		Effect.gen(function* () {
			const notifications = yield* Notifications.Service;
			const { level, ...place } = input;
			return yield* named(principal, place.id, (principal, placeId) =>
				Effect.gen(function* () {
					const isMember = yield* proveIsMember(principal);
					// Clearing removes only the member's own choice, so it needs no reach.
					if (level === null) return yield* notifications.clearLevel(isMember, place);
					const reached = yield* provePlaceReached(principal, placeId, place.kind);
					return yield* notifications.setLevel(isMember, reached, level);
				}),
			);
		}),
);
