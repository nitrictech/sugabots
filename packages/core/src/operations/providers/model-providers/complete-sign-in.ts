import { ProviderSignInAttemptInvalid } from "@sugabots/contracts/errors/providers";
import { providersContracts } from "@sugabots/contracts/operations/providers";
import { Effect } from "effect";
import { proveInWorkspace } from "../../../proofs/in-workspace.ts";
import { named } from "../../../proofs/proof.ts";
import { proveReachesModelProvider } from "../../../proofs/reaches-model-provider.ts";
import { proveCanManageWorkspace } from "../../../proofs/workspace-permissions.ts";
import { ModelProviders } from "../../../providers/model-providers/model-providers.ts";
import { workspaceIdOf } from "../../../workspaces/workspace-reference.ts";
import { defineOperation } from "../../operation.ts";

export const completeSignIn = defineOperation(
	providersContracts["modelProviders.completeSignIn"],
	(principal, input) =>
		Effect.gen(function* () {
			const modelProviders = yield* ModelProviders.Service;
			const workspaceId = yield* workspaceIdOf(input.workspace).pipe(
				Effect.mapError(() => new ProviderSignInAttemptInvalid()),
			);
			return yield* named(
				principal,
				workspaceId,
				input.providerId,
				(principal, workspace, provider) =>
					Effect.gen(function* () {
						const canManage = yield* proveInWorkspace(principal, workspace).pipe(
							Effect.flatMap(proveCanManageWorkspace),
							Effect.mapError(() => new ProviderSignInAttemptInvalid()),
						);
						return yield* proveReachesModelProvider(canManage, provider)
							.pipe(Effect.flatMap((reach) => modelProviders.completeSignIn(reach, input.attempt)))
							.pipe(
								Effect.catchTags({
									ModelProviderNotFound: () => Effect.fail(new ProviderSignInAttemptInvalid()),
									ResourceHidden: () => Effect.fail(new ProviderSignInAttemptInvalid()),
								}),
							);
					}),
			);
		}),
);
