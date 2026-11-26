import { computersContracts } from "@sugabots/contracts/operations/computers";
import { Effect } from "effect";
import { ComputerNetwork } from "../../computers/computer-network.ts";
import { defineOperation } from "../operation.ts";
import { managingWorkspace } from "../workspace-openings.ts";

export const addWorkspaceHost = defineOperation(
	computersContracts["computerProviders.addHost"],
	(principal, input) =>
		Effect.gen(function* () {
			const network = yield* ComputerNetwork.Service;
			return yield* managingWorkspace(principal, input.workspace, (canManage) =>
				network.addHost(canManage, input.host),
			);
		}),
);
