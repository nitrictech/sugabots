import { workspaceContracts } from "@sugabots/contracts/operations/workspace";
import { Effect } from "effect";
import { Accounts } from "../../accounts/accounts.ts";
import { proveHoldsInvitation } from "../../proofs/holds-invitation.ts";
import { proveIsMember } from "../../proofs/is-member.ts";
import { named } from "../../proofs/proof.ts";
import { Membership } from "../../workspaces/membership/membership.ts";
import { defineOperation } from "../operation.ts";

/** Accepting again, as a second tab or a reload does, answers with the workspace and changes nothing. */
export const acceptInvitation = defineOperation(
	workspaceContracts["workspaces.acceptInvitation"],
	(principal, input) =>
		Effect.gen(function* () {
			const membership = yield* Membership.Service;
			const accounts = yield* Accounts.Service;
			return yield* named(principal, input.invitationId, (principal, invitation) =>
				Effect.gen(function* () {
					const isMember = yield* proveIsMember(principal);
					// Proved under the workspace's lock, in the transaction that lets them in.
					return yield* membership
						.accept(proveHoldsInvitation(principal, invitation, accounts))
						.pipe(
							Effect.catchTag("ResourceHidden", () =>
								membership.alreadyAccepted(isMember, invitation.value),
							),
						);
				}),
			);
		}),
);
