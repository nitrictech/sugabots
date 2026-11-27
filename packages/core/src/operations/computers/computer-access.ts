import { computersContracts } from "@sugabots/contracts/operations/computers";
import { Effect } from "effect";
import { ComputerProviderSetup } from "../../computers/computer-provider-setup.ts";
import { defineOperation } from "../operation.ts";
import { readingWorkspace } from "../workspace-openings.ts";

export const computerAccess = defineOperation(
	computersContracts["computerProviders.access"],
	(principal, input) =>
		Effect.gen(function* () {
			const setup = yield* ComputerProviderSetup.Service;
			return yield* readingWorkspace(principal, input.workspace, (canRead) =>
				setup.access(canRead),
			);
		}),
);
