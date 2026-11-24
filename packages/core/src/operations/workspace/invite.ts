import { workspaceContracts } from "@sugabots/contracts/operations/workspace";
import { Effect } from "effect";
import { proveCanInvite } from "../../proofs/membership-changes.ts";
import { named } from "../../proofs/proof.ts";
import { Membership } from "../../workspaces/membership/membership.ts";
import { workspaceIdOf } from "../../workspaces/workspace-reference.ts";
import { defineOperation } from "../operation.ts";

export const invite = defineOperation(workspaceContracts["workspaces.invite"], (principal, input) =>
	Effect.gen(function* () {
		const membership = yield* Membership.Service;
		const { workspace: reference, role, ...invitation } = input;
		const workspaceId = yield* workspaceIdOf(reference);
		return yield* named(principal, workspaceId, (principal, workspace) =>
			// Proved under the workspace's lock, in the transaction that sends it.
			membership.invite(proveCanInvite(principal, workspace, role), invitation),
		);
	}),
);
