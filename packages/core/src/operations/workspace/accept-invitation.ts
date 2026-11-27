import { ResourceHidden } from "@sugabots/contracts/errors/proofs";
import { workspaceContracts } from "@sugabots/contracts/operations/workspace";
import { Effect } from "effect";
import { Accounts } from "../../accounts/accounts.ts";
import { proveHoldsInvitation } from "../../proofs/holds-invitation.ts";
import { proveIsMember } from "../../proofs/is-member.ts";
import { named } from "../../proofs/proof.ts";
import { underWorkspaceLock } from "../../proofs/workspace-lock.ts";
import { Membership } from "../../workspaces/membership/membership.ts";
import { workspaceOfInvitation } from "../../workspaces/workspace-reference.ts";
import { defineOperation } from "../operation.ts";

/** Accepting again, as a second tab or a reload does, answers with the workspace and changes nothing. */
export const acceptInvitation = defineOperation(
	workspaceContracts["workspaces.acceptInvitation"],
	(principal, input) =>
		Effect.gen(function* () {
			const membership = yield* Membership.Service;
			const accounts = yield* Accounts.Service;
			const workspaceId = yield* workspaceOfInvitation(input.invitationId);
			// Read again and accepted under its workspace's lock, with the invitation named afresh there.
			const accepting =
				workspaceId === undefined
					? Effect.fail(new ResourceHidden({ resource: "invitation" }))
					: underWorkspaceLock(principal, workspaceId, (lock) =>
							named(input.invitationId, (invitation) =>
								Effect.flatMap(proveHoldsInvitation(lock, invitation, accounts), membership.accept),
							),
						);
			return yield* accepting.pipe(
				Effect.catchTag("ResourceHidden", () =>
					named(principal, input.invitationId, (principal, invitation) =>
						Effect.flatMap(proveIsMember(principal), (isMember) =>
							membership.alreadyAccepted(isMember, invitation),
						),
					),
				),
			);
		}),
);
