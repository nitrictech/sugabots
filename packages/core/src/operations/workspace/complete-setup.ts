import { workspaceContracts } from "@sugabots/contracts/operations/workspace";
import { Effect } from "effect";
import { proveInWorkspace } from "../../proofs/in-workspace.ts";
import { named } from "../../proofs/proof.ts";
import { proveReachesSetupBot } from "../../proofs/reaches-setup-bot.ts";
import { proveCanManageWorkspace } from "../../proofs/workspace-permissions.ts";
import { WorkspaceSetup } from "../../workspaces/workspace-setup/workspace-setup.ts";
import { defineOperation } from "../operation.ts";

export const completeSetup = defineOperation(
	workspaceContracts["workspaceSetup.complete"],
	(principal, input) =>
		Effect.gen(function* () {
			const workspaceSetup = yield* WorkspaceSetup.Service;
			return yield* named(principal, input.workspaceId, input.botId, (principal, workspace, bot) =>
				Effect.gen(function* () {
					const canManage = yield* proveCanManageWorkspace(
						yield* proveInWorkspace(principal, workspace),
					);
					const target = yield* proveReachesSetupBot(canManage, bot);
					return yield* workspaceSetup.complete(canManage, bot, target);
				}),
			);
		}),
);
