import { workspaceContracts } from "@sugabots/contracts/operations/workspace";
import { Effect } from "effect";
import { Usage } from "../../accounting/usage.ts";
import { proveInWorkspace } from "../../proofs/in-workspace.ts";
import { named } from "../../proofs/proof.ts";
import { proveCanManageWorkspace } from "../../proofs/workspace-permissions.ts";
import { workspaceIdOf } from "../../workspaces/workspace-reference.ts";
import { defineOperation } from "../operation.ts";

export const usageMonth = defineOperation(workspaceContracts["usage.month"], (principal, input) =>
	Effect.gen(function* () {
		const usage = yield* Usage.Service;
		const workspaceId = yield* workspaceIdOf(input.workspace);
		return yield* named(principal, workspaceId, (principal, workspace) =>
			Effect.gen(function* () {
				const canManage = yield* proveCanManageWorkspace(
					yield* proveInWorkspace(principal, workspace),
				);
				return yield* usage.month(canManage, input.month);
			}),
		);
	}),
);
