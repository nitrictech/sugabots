import { ResourceHidden } from "@sugabots/contracts/errors/proofs";
import { workspaceContracts } from "@sugabots/contracts/operations/workspace";
import { Effect } from "effect";
import { proveCanInvite } from "../../proofs/membership-changes.ts";
import { named } from "../../proofs/proof.ts";
import { pendingInvitationOf } from "../../workspaces/membership/member-reads.ts";
import { Membership } from "../../workspaces/membership/membership.ts";
import { defineOperation } from "../operation.ts";

/** Whoever may send an invitation with its role may cancel it: an admin invitation, only the owner. */
export const cancelInvitation = defineOperation(
	workspaceContracts["workspaces.cancelInvitation"],
	(principal, input) =>
		Effect.gen(function* () {
			const membership = yield* Membership.Service;
			const hidden = new ResourceHidden({ resource: "invitation" });
			const pending = yield* pendingInvitationOf(input.invitationId);
			if (!pending) return yield* hidden;
			return yield* named(principal, pending.workspaceId, (principal, workspace) =>
				// Proved under the workspace's lock, in the transaction that cancels it.
				membership.cancelInvitation(
					proveCanInvite(principal, workspace, pending.role),
					input.invitationId,
				),
			).pipe(
				// A workspace the caller isn't in is hidden, so an invitation to it is
				// answered exactly as one that doesn't exist.
				Effect.catchTag("ResourceHidden", () => Effect.fail(hidden)),
			);
		}),
);
