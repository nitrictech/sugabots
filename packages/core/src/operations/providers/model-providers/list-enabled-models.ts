import { providersContracts } from "@sugabots/contracts/operations/providers";
import { Effect } from "effect";
import { ModelProviders } from "../../../providers/model-providers/model-providers.ts";
import { defineOperation } from "../../operation.ts";
import { readingWorkspace } from "../../workspace-openings.ts";

export const listEnabledModels = defineOperation(
	providersContracts["modelProviders.listEnabledModels"],
	(principal, input) =>
		Effect.gen(function* () {
			const modelProviders = yield* ModelProviders.Service;
			return yield* readingWorkspace(principal, input.workspace, (canRead) =>
				modelProviders.listEnabledModels(canRead),
			);
		}),
);
