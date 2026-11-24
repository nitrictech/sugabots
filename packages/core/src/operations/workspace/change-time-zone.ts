import { workspaceContracts } from "@sugabots/contracts/operations/workspace";
import { Effect } from "effect";
import { proveInWorkspace } from "../../proofs/in-workspace.ts";
import { named } from "../../proofs/proof.ts";
import { proveCanManageWorkspace } from "../../proofs/workspace-permissions.ts";
import { WorkspaceTimeZone } from "../../workspaces/time-zone/workspace-time-zone.ts";
import { workspaceIdOf } from "../../workspaces/workspace-reference.ts";
import { defineOperation } from "../operation.ts";

export const changeTimeZone = defineOperation(
	workspaceContracts["workspaces.changeTimeZone"],
	(principal, input) =>
		Effect.gen(function* () {
			const timeZones = yield* WorkspaceTimeZone.Service;
			const workspaceId = yield* workspaceIdOf(input.workspace);
			return yield* named(principal, workspaceId, (principal, workspace) =>
				Effect.gen(function* () {
					const canManage = yield* proveCanManageWorkspace(
						yield* proveInWorkspace(principal, workspace),
					);
					return yield* timeZones.change(canManage, input.timeZone);
				}),
			);
		}),
);
