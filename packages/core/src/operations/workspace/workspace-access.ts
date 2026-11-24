import { workspaceContracts } from "@sugabots/contracts/operations/workspace";
import { Effect } from "effect";
import { proveInWorkspace } from "../../proofs/in-workspace.ts";
import { named } from "../../proofs/proof.ts";
import { proveCanReadWorkspace } from "../../proofs/workspace-permissions.ts";
import { Membership } from "../../workspaces/membership/membership.ts";
import { workspaceIdOf } from "../../workspaces/workspace-reference.ts";
import { defineOperation } from "../operation.ts";

export const workspaceAccess = defineOperation(
	workspaceContracts["system.workspaceAccess"],
	(principal, input) =>
		Effect.gen(function* () {
			const membership = yield* Membership.Service;
			const workspaceId = yield* workspaceIdOf(input.workspace);
			return yield* named(principal, workspaceId, (principal, workspace) =>
				Effect.flatMap(
					Effect.flatMap(proveInWorkspace(principal, workspace), proveCanReadWorkspace),
					membership.access,
				),
			);
		}),
);
