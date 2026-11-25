import { ResourceHidden } from "@sugabots/contracts/errors/proofs";
import { workspaceContracts } from "@sugabots/contracts/operations/workspace";
import { Effect } from "effect";
import { proveCanCancelInvitation } from "../../proofs/can-cancel-invitation.ts";
import { named } from "../../proofs/proof.ts";
import { underWorkspaceLock } from "../../proofs/workspace-lock.ts";
import { Membership } from "../../workspaces/membership/membership.ts";
import { workspaceOfInvitation } from "../../workspaces/workspace-reference.ts";
import { defineOperation } from "../operation.ts";

/** Whoever may send an invitation with its role may cancel it: an admin invitation, only the owner. */
export const cancelInvitation = defineOperation(
	workspaceContracts["workspaces.cancelInvitation"],
	(principal, input) =>
		Effect.gen(function* () {
			const membership = yield* Membership.Service;
			const hidden = new ResourceHidden({ resource: "invitation" });
			const workspaceId = yield* workspaceOfInvitation(input.invitationId);
			if (workspaceId === undefined) return yield* hidden;
			// Read again, proved and cancelled under the workspace's lock.
			return yield* underWorkspaceLock(principal, workspaceId, (lock) =>
				named(input.invitationId, (invitation) =>
					Effect.flatMap(proveCanCancelInvitation(lock, invitation), (canCancel) =>
						membership.cancelInvitation(invitation, canCancel),
					),
				),
			).pipe(
				// A workspace the caller isn't in is hidden, so an invitation to it is
				// answered exactly as one that doesn't exist.
				Effect.catchTag("ResourceHidden", () => Effect.fail(hidden)),
			);
		}),
);
