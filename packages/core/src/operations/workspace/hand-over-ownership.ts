import { workspaceContracts } from "@sugabots/contracts/operations/workspace";
import { Effect } from "effect";
import { proveCanHandOverOwnership } from "../../proofs/membership-changes.ts";
import { named } from "../../proofs/proof.ts";
import { underWorkspaceLock } from "../../proofs/workspace-lock.ts";
import { memberOfMembership } from "../../workspaces/membership/member-reads.ts";
import { Membership } from "../../workspaces/membership/membership.ts";
import { workspaceIdOf } from "../../workspaces/workspace-reference.ts";

import { defineOperation } from "../operation.ts";

export const handOverOwnership = defineOperation(
	workspaceContracts["workspaces.handOverOwnership"],
	(principal, input) =>
		Effect.gen(function* () {
			const membership = yield* Membership.Service;
			const workspaceId = yield* workspaceIdOf(input.workspace);
			// Proved and made under the workspace's lock, with the member named afresh there.
			return yield* underWorkspaceLock(principal, workspaceId, (lock) =>
				Effect.flatMap(memberOfMembership(workspaceId, input.membershipId), (memberId) =>
					named(memberId, (member) =>
						Effect.flatMap(proveCanHandOverOwnership(lock, member), membership.handOverOwnership),
					),
				),
			);
		}),
);
