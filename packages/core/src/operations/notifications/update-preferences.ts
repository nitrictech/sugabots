import { notificationsContracts } from "@sugabots/contracts/operations/notifications";
import { Effect } from "effect";
import { Notifications } from "../../notifications/notifications.ts";
import { proveIsMember } from "../../proofs/is-member.ts";
import { named } from "../../proofs/proof.ts";
import { defineOperation } from "../operation.ts";

export const updatePreferences = defineOperation(
	notificationsContracts["notifications.updatePreferences"],
	(principal, input) =>
		Effect.gen(function* () {
			const notifications = yield* Notifications.Service;
			return yield* named(principal, (principal) =>
				Effect.flatMap(proveIsMember(principal), (isMember) =>
					notifications.updatePreferences(isMember, input),
				),
			);
		}),
);
