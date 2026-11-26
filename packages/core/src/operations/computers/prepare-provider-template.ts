import { computersContracts } from "@sugabots/contracts/operations/computers";
import { Effect } from "effect";
import { ComputerProviderSetup } from "../../computers/computer-provider-setup.ts";
import { proveReachesComputerProvider } from "../../proofs/reaches-computer-provider.ts";
import { defineOperation } from "../operation.ts";
import { managingWorkspace } from "../workspace-openings.ts";

export const prepareProviderTemplate = defineOperation(
	computersContracts["computerProviders.prepareTemplate"],
	(principal, input) =>
		Effect.gen(function* () {
			const setup = yield* ComputerProviderSetup.Service;
			return yield* managingWorkspace(
				principal,
				input.workspace,
				input.providerId,
				(canManage, provider) =>
					Effect.gen(function* () {
						const target = yield* proveReachesComputerProvider(canManage, provider);
						return yield* setup.prepareTemplate(canManage, provider, target);
					}),
			);
		}),
);
