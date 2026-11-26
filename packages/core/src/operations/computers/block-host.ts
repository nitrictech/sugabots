import { computersContracts } from "@sugabots/contracts/operations/computers";
import { Effect } from "effect";
import { ComputerNetwork } from "../../computers/computer-network.ts";
import { defineOperation } from "../operation.ts";
import { managingWorkspace } from "../workspace-openings.ts";

export const blockHost = defineOperation(
	computersContracts["computerProviders.blockHost"],
	(principal, input) =>
		Effect.gen(function* () {
			const network = yield* ComputerNetwork.Service;
			return yield* managingWorkspace(principal, input.workspace, (canManage) =>
				network.blockHost(canManage, input.host),
			);
		}),
);
