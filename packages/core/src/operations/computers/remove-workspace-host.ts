import { computersContracts } from "@sugabots/contracts/operations/computers";
import { Effect } from "effect";
import { ComputerNetwork } from "../../computers/computer-network.ts";
import { defineOperation } from "../operation.ts";
import { managingWorkspace } from "../workspace-openings.ts";

export const removeWorkspaceHost = defineOperation(
	computersContracts["computerProviders.removeHost"],
	(principal, input) =>
		Effect.gen(function* () {
			const network = yield* ComputerNetwork.Service;
			return yield* managingWorkspace(principal, input.workspace, (canManage) =>
				network.removeHost(canManage, input.host),
			);
		}),
);
