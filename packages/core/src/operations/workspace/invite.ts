import { workspaceContracts } from "@sugabots/contracts/operations/workspace";
import { Effect } from "effect";
import { proveCanInvite } from "../../proofs/membership-changes.ts";
import { underWorkspaceLock } from "../../proofs/workspace-lock.ts";
import { Membership } from "../../workspaces/membership/membership.ts";
import { workspaceIdOf } from "../../workspaces/workspace-reference.ts";
import { defineOperation } from "../operation.ts";

export const invite = defineOperation(workspaceContracts["workspaces.invite"], (principal, input) =>
	Effect.gen(function* () {
		const membership = yield* Membership.Service;
		const { workspace: reference, role, ...invitation } = input;
		const workspaceId = yield* workspaceIdOf(reference);
		// Proved and sent under the workspace's lock; its email goes once that commits.
		return yield* underWorkspaceLock(principal, workspaceId, (lock) =>
			Effect.flatMap(proveCanInvite(lock, role), (canInvite) =>
				membership.invite(canInvite, invitation),
			),
		);
	}),
);
