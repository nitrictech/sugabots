import { providersContracts } from "@sugabots/contracts/operations/providers";
import { Effect } from "effect";
import { ModelProviders } from "../../../providers/model-providers/model-providers.ts";
import { defineOperation } from "../../operation.ts";
import { managingWorkspace } from "../../workspace-openings.ts";

export const create = defineOperation(
	providersContracts["modelProviders.create"],
	(principal, input) =>
		Effect.gen(function* () {
			const modelProviders = yield* ModelProviders.Service;
			return yield* managingWorkspace(principal, input.workspace, (canManage) =>
				modelProviders.create(canManage, input.provider),
			);
		}),
);
