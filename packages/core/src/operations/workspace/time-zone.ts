import { workspaceContracts } from "@sugabots/contracts/operations/workspace";
import { Effect } from "effect";
import { WorkspaceTimeZone } from "../../workspaces/time-zone/workspace-time-zone.ts";
import { defineOperation } from "../operation.ts";
import { managingWorkspace } from "../workspace-openings.ts";

export const timeZone = defineOperation(
	workspaceContracts["workspaces.timeZone"],
	(principal, input) =>
		Effect.gen(function* () {
			const timeZones = yield* WorkspaceTimeZone.Service;
			return yield* managingWorkspace(principal, input.workspace, (canManage) =>
				timeZones.get(canManage),
			);
		}),
);
