import { workspaceContracts } from "@sugabots/contracts/operations/workspace";
import { Effect } from "effect";
import { proveInWorkspace } from "../../proofs/in-workspace.ts";
import { named } from "../../proofs/proof.ts";
import { proveCanManageWorkspace } from "../../proofs/workspace-permissions.ts";
import { Membership } from "../../workspaces/membership/membership.ts";
import { workspaceIdOf } from "../../workspaces/workspace-reference.ts";
import { defineOperation } from "../operation.ts";

export const update = defineOperation(workspaceContracts["workspaces.update"], (principal, input) =>
	Effect.gen(function* () {
		const membership = yield* Membership.Service;
		const { workspace: _workspace, ...details } = input;
		const workspaceId = yield* workspaceIdOf(input.workspace);
		return yield* named(principal, workspaceId, (principal, workspace) =>
			Effect.gen(function* () {
				const canManage = yield* proveCanManageWorkspace(
					yield* proveInWorkspace(principal, workspace),
				);
				return yield* membership.update(canManage, details);
			}),
		);
	}),
);
