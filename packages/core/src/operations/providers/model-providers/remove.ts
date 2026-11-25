import { ModelProviderRemovalNotAllowed } from "@sugabots/contracts/errors/providers";
import { providersContracts } from "@sugabots/contracts/operations/providers";
import { Effect } from "effect";
import { proveInWorkspace } from "../../../proofs/in-workspace.ts";
import { named } from "../../../proofs/proof.ts";
import { proveReachesModelProvider } from "../../../proofs/reaches-model-provider.ts";
import { proveCanManageWorkspace } from "../../../proofs/workspace-permissions.ts";
import { ModelProviders } from "../../../providers/model-providers/model-providers.ts";
import { workspaceIdOf } from "../../../workspaces/workspace-reference.ts";
import { defineOperation } from "../../operation.ts";

export const remove = defineOperation(
	providersContracts["modelProviders.remove"],
	(principal, input) =>
		Effect.gen(function* () {
			const modelProviders = yield* ModelProviders.Service;
			const workspaceId = yield* workspaceIdOf(input.workspace);
			return yield* named(
				principal,
				workspaceId,
				input.providerId,
				(principal, workspace, provider) =>
					Effect.gen(function* () {
						const canManage = yield* proveCanManageWorkspace(
							yield* proveInWorkspace(principal, workspace),
						);
						const reach = yield* proveReachesModelProvider(canManage, provider).pipe(
							Effect.mapError(() => new ModelProviderRemovalNotAllowed()),
						);
						return yield* modelProviders.remove(reach);
					}),
			);
		}),
);
