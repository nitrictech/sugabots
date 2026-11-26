import { computersContracts } from "@sugabots/contracts/operations/computers";
import { Effect } from "effect";
import { ComputerProviderSetup } from "../../computers/computer-provider-setup.ts";
import { defineOperation } from "../operation.ts";
import { managingWorkspace } from "../workspace-openings.ts";

export const createProvider = defineOperation(
	computersContracts["computerProviders.create"],
	(principal, input) =>
		Effect.gen(function* () {
			const setup = yield* ComputerProviderSetup.Service;
			const { workspace: reference, ...provider } = input;
			return yield* managingWorkspace(principal, reference, (canManage) =>
				setup.create(canManage, provider),
			);
		}),
);
