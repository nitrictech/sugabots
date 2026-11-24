import { computersContracts } from "@sugabots/contracts/operations/computers";
import { Effect } from "effect";
import { ComputerProviderSetup } from "../../computers/computer-provider-setup.ts";
import { proveInWorkspace } from "../../proofs/in-workspace.ts";
import { named } from "../../proofs/proof.ts";
import { proveCanManageWorkspace } from "../../proofs/workspace-permissions.ts";
import { workspaceIdOf } from "../../workspaces/workspace-reference.ts";
import { defineOperation } from "../operation.ts";

export const prepareProviderTemplate = defineOperation(
	computersContracts["computerProviders.prepareTemplate"],
	(principal, input) =>
		Effect.gen(function* () {
			const setup = yield* ComputerProviderSetup.Service;
			const workspaceId = yield* workspaceIdOf(input.workspace);
			return yield* named(principal, workspaceId, (principal, workspace) =>
				Effect.gen(function* () {
					const canManage = yield* proveCanManageWorkspace(
						yield* proveInWorkspace(principal, workspace),
					);
					return yield* setup.prepareTemplate(canManage, input.providerId);
				}),
			);
		}),
);
