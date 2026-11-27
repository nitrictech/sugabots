import { workspaceContracts } from "@sugabots/contracts/operations/workspace";
import { Effect } from "effect";
import { Turns } from "../../chats/turns/turns.ts";
import { proveCanDeleteWorkspace } from "../../proofs/membership-changes.ts";
import { underWorkspaceLock } from "../../proofs/workspace-lock.ts";
import { Membership } from "../../workspaces/membership/membership.ts";
import { workspaceIdOf } from "../../workspaces/workspace-reference.ts";

import { finishDeletion } from "../finish-deletion.ts";
import { defineOperation } from "../operation.ts";

export const deleteWorkspace = defineOperation(
	workspaceContracts["workspaces.delete"],
	(principal, input) =>
		Effect.gen(function* () {
			const withdrawals = yield* Turns.ApprovalWithdrawals.Service;
			const membership = yield* Membership.Service;
			const workspaceId = yield* workspaceIdOf(input.workspace);
			yield* underWorkspaceLock(
				principal,
				workspaceId,
				(lock) =>
					Effect.flatMap(proveCanDeleteWorkspace(lock), membership.beginDeletion).pipe(
						Effect.tap(() => withdrawals.afterDeletionStarts(lock)),
					),
				{ allowDeleting: true },
			);
			yield* finishDeletion(principal, workspaceId, { kind: "workspace", id: workspaceId });
		}),
);
