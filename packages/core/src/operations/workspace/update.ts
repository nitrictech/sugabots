import { workspaceContracts } from "@sugabots/contracts/operations/workspace";
import { Effect } from "effect";
import { Membership } from "../../workspaces/membership/membership.ts";
import { defineOperation } from "../operation.ts";
import { managingWorkspace } from "../workspace-openings.ts";

export const update = defineOperation(workspaceContracts["workspaces.update"], (principal, input) =>
	Effect.gen(function* () {
		const membership = yield* Membership.Service;
		const { workspace: _workspace, ...details } = input;
		return yield* managingWorkspace(principal, input.workspace, (canManage) =>
			membership.update(canManage, details),
		);
	}),
);
