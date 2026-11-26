import { workspaceContracts } from "@sugabots/contracts/operations/workspace";
import { Effect } from "effect";
import { Usage } from "../../accounting/usage.ts";
import { defineOperation } from "../operation.ts";
import { managingWorkspace } from "../workspace-openings.ts";

export const usageMonth = defineOperation(workspaceContracts["usage.month"], (principal, input) =>
	Effect.gen(function* () {
		const usage = yield* Usage.Service;
		return yield* managingWorkspace(principal, input.workspace, (canManage) =>
			usage.month(canManage, input.month),
		);
	}),
);
