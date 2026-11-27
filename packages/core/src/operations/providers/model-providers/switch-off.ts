import { providersContracts } from "@sugabots/contracts/operations/providers";
import { Effect } from "effect";
import { proveReachesModelProvider } from "../../../proofs/reaches-model-provider.ts";
import { ModelProviders } from "../../../providers/model-providers/model-providers.ts";
import { defineOperation } from "../../operation.ts";
import { managingWorkspace } from "../../workspace-openings.ts";

export const switchOff = defineOperation(
	providersContracts["modelProviders.switchOff"],
	(principal, input) =>
		Effect.gen(function* () {
			const modelProviders = yield* ModelProviders.Service;
			const { workspace: reference, providerId, ...moves } = input;
			return yield* managingWorkspace(principal, reference, providerId, (canManage, provider) =>
				Effect.gen(function* () {
					const reach = yield* proveReachesModelProvider(canManage, provider);
					return yield* modelProviders.switchOff(reach, moves);
				}),
			);
		}),
);
