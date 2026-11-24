import { workspaceContracts } from "@sugabots/contracts/operations/workspace";
import { Effect } from "effect";
import { Accounts } from "../../accounts/accounts.ts";
import { proveHoldsInvitation } from "../../proofs/holds-invitation.ts";
import { proveIsMember } from "../../proofs/is-member.ts";
import { named } from "../../proofs/proof.ts";
import { Membership } from "../../workspaces/membership/membership.ts";
import { defineOperation } from "../operation.ts";

export const invitation = defineOperation(
	workspaceContracts["workspaces.invitation"],
	(principal, input) =>
		Effect.gen(function* () {
			const membership = yield* Membership.Service;
			const accounts = yield* Accounts.Service;
			return yield* named(principal, input.invitationId, (principal, invitation) =>
				Effect.gen(function* () {
					const isMember = yield* proveIsMember(principal);
					return yield* membership
						.invitation(proveHoldsInvitation(principal, invitation, accounts))
						.pipe(
							Effect.catchTag("ResourceHidden", () =>
								Effect.map(
									membership.alreadyAccepted(isMember, invitation.value),
									({ workspaceId }) => ({ status: "accepted" as const, workspaceId }),
								),
							),
						);
				}),
			);
		}),
);
