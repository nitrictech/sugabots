import { workspaceContracts } from "@sugabots/contracts/operations/workspace";
import { Effect } from "effect";
import { proveCanDeleteWorkspace } from "../../proofs/membership-changes.ts";
import { named } from "../../proofs/proof.ts";
import { Membership } from "../../workspaces/membership/membership.ts";
import { workspaceIdOf } from "../../workspaces/workspace-reference.ts";
import { defineOperation } from "../operation.ts";

export const deleteWorkspace = defineOperation(
	workspaceContracts["workspaces.delete"],
	(principal, input) =>
		Effect.gen(function* () {
			const membership = yield* Membership.Service;
			const workspaceId = yield* workspaceIdOf(input.workspace);
			return yield* named(principal, workspaceId, (principal, workspace) =>
				// Proved under the workspace's lock, before its computers go and again as it does.
				membership.delete(proveCanDeleteWorkspace(principal, workspace)),
			);
		}),
);
