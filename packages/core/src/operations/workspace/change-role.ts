import { workspaceContracts } from "@sugabots/contracts/operations/workspace";
import { Effect } from "effect";
import { proveCanChangeMembership } from "../../proofs/membership-changes.ts";
import { named } from "../../proofs/proof.ts";
import { memberOfMembership } from "../../workspaces/membership/member-reads.ts";
import { Membership } from "../../workspaces/membership/membership.ts";
import { workspaceIdOf } from "../../workspaces/workspace-reference.ts";
import { defineOperation } from "../operation.ts";

export const changeRole = defineOperation(
	workspaceContracts["workspaces.changeRole"],
	(principal, input) =>
		Effect.gen(function* () {
			const membership = yield* Membership.Service;
			const workspaceId = yield* workspaceIdOf(input.workspace);
			const memberId = yield* memberOfMembership(workspaceId, input.membershipId);
			return yield* named(principal, workspaceId, memberId, (principal, workspace, member) =>
				// Proved under the workspace's lock, in the transaction that makes the change.
				membership.changeRole(
					proveCanChangeMembership(principal, workspace, member, {
						kind: "role",
						role: input.role,
					}),
				),
			);
		}),
);
