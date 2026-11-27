import { computersContracts } from "@sugabots/contracts/operations/computers";
import { Effect } from "effect";
import { ComputerProviderSetup } from "../../computers/computer-provider-setup.ts";
import { defineOperation } from "../operation.ts";
import { managingWorkspace } from "../workspace-openings.ts";

export const listProviders = defineOperation(
	computersContracts["computerProviders.list"],
	(principal, input) =>
		Effect.gen(function* () {
			const setup = yield* ComputerProviderSetup.Service;
			return yield* managingWorkspace(principal, input.workspace, (canManage) =>
				setup.list(canManage),
			);
		}),
);
