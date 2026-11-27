import { workspaceContracts } from "@sugabots/contracts/operations/workspace";
import { Effect } from "effect";
import { proveCanLeaveWorkspace } from "../../proofs/membership-changes.ts";
import { underWorkspaceLock } from "../../proofs/workspace-lock.ts";
import { Membership } from "../../workspaces/membership/membership.ts";
import { workspaceIdOf } from "../../workspaces/workspace-reference.ts";

import { defineOperation } from "../operation.ts";

export const leave = defineOperation(workspaceContracts["workspaces.leave"], (principal, input) =>
	Effect.gen(function* () {
		const membership = yield* Membership.Service;
		const workspaceId = yield* workspaceIdOf(input.workspace);
		// Proved and made under the workspace's lock.
		return yield* underWorkspaceLock(principal, workspaceId, (lock) =>
			Effect.flatMap(proveCanLeaveWorkspace(lock), membership.beginLeaving),
		);
	}),
);
