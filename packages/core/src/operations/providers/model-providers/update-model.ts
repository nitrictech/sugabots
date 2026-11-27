import { providersContracts } from "@sugabots/contracts/operations/providers";
import { Effect } from "effect";
import { proveInWorkspace } from "../../../proofs/in-workspace.ts";
import { named } from "../../../proofs/proof.ts";
import {
	proveReachesModelProvider,
	proveReachesProviderModel,
} from "../../../proofs/reaches-model-provider.ts";
import { proveCanManageWorkspace } from "../../../proofs/workspace-permissions.ts";
import { ModelProviders } from "../../../providers/model-providers/model-providers.ts";
import { workspaceIdOf } from "../../../workspaces/workspace-reference.ts";
import { defineOperation } from "../../operation.ts";

export const updateModel = defineOperation(
	providersContracts["modelProviders.updateModel"],
	(principal, input) =>
		Effect.gen(function* () {
			const modelProviders = yield* ModelProviders.Service;
			const workspaceId = yield* workspaceIdOf(input.workspace);
			return yield* named(
				principal,
				workspaceId,
				input.providerId,
				input.modelId,
				(principal, workspace, provider, model) =>
					Effect.gen(function* () {
						const canManage = yield* proveCanManageWorkspace(
							yield* proveInWorkspace(principal, workspace),
						);
						const reach = yield* proveReachesModelProvider(canManage, provider);
						return yield* modelProviders.updateModel(
							yield* proveReachesProviderModel(reach, model),
							input.changes,
						);
					}),
			);
		}),
);
