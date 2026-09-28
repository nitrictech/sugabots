import { BadRequest, Conflict, NotFound } from "@sugabots/contracts/http";
import type { TurnModel } from "@sugabots/core/conversations/turns/model";
import { modelProviderOperations } from "@sugabots/core/providers/model-providers/operations";
import type { ModelProviderStore } from "@sugabots/core/providers/model-providers/store";
import type {
	EgressHttpClients,
	EgressUrlValidator,
} from "@sugabots/core/providers/network/egress";
import { Effect } from "effect";
import { HttpApiBuilder } from "effect/unstable/httpapi";
import { ServerApi } from "../../http/api.ts";
import { grantedWorkspace } from "../../http/authorisation.ts";
import { asHttpError } from "../../http/errors.ts";

export interface ModelProviderRoutesOptions {
	modelProviders: ModelProviderStore;
	httpClients: EgressHttpClients;
	validateProviderUrl: EgressUrlValidator;
	model: TurnModel;
}

export function modelProviderRoutes({
	modelProviders,
	httpClients,
	validateProviderUrl,
	model,
}: ModelProviderRoutesOptions) {
	const operations = modelProviderOperations({
		providers: modelProviders,
		httpClients,
		validateProviderUrl,
		model,
	});

	return HttpApiBuilder.group(ServerApi, "modelProviders", (handlers) =>
		handlers
			.handle("list", () =>
				Effect.flatMap(grantedWorkspace, ({ workspaceId }) => operations.list(workspaceId)),
			)
			.handle("listEnabledModels", () =>
				Effect.flatMap(grantedWorkspace, ({ workspaceId }) => operations.listEnabled(workspaceId)),
			)
			.handle("create", ({ payload }) =>
				Effect.flatMap(grantedWorkspace, ({ workspaceId, actor }) =>
					operations.create(workspaceId, actor.userId, payload).pipe(asHttpError(providerErrors)),
				),
			)
			.handle("get", ({ params }) =>
				Effect.flatMap(grantedWorkspace, ({ workspaceId }) =>
					operations.get(workspaceId, params.providerId).pipe(asHttpError(providerErrors)),
				),
			)
			.handle("update", ({ params, payload }) =>
				Effect.flatMap(grantedWorkspace, ({ workspaceId }) =>
					operations
						.update(workspaceId, params.providerId, payload)
						.pipe(asHttpError(providerErrors)),
				),
			)
			.handle("remove", ({ params }) =>
				Effect.flatMap(grantedWorkspace, ({ workspaceId }) =>
					operations.remove(workspaceId, params.providerId).pipe(asHttpError(providerErrors)),
				),
			)
			.handle("test", ({ params }) =>
				Effect.flatMap(grantedWorkspace, ({ workspaceId }) =>
					operations.test(workspaceId, params.providerId).pipe(asHttpError(providerErrors)),
				),
			)
			.handle("fetchModels", ({ params }) =>
				Effect.flatMap(grantedWorkspace, ({ workspaceId }) =>
					operations.fetchModels(workspaceId, params.providerId),
				),
			)
			.handle("addModel", ({ params, payload }) =>
				Effect.flatMap(grantedWorkspace, ({ workspaceId }) =>
					operations
						.addModel(workspaceId, params.providerId, payload)
						.pipe(asHttpError(providerErrors)),
				),
			)
			.handle("setModelsEnabled", ({ params, payload }) =>
				Effect.flatMap(grantedWorkspace, ({ workspaceId }) =>
					operations
						.setModelsEnabled(workspaceId, params.providerId, payload.modelIds, payload.enabled)
						.pipe(
							asHttpError(providerErrors),
							Effect.map((updated) => ({ updated })),
						),
				),
			)
			.handle("updateModel", ({ params, payload }) =>
				Effect.flatMap(grantedWorkspace, ({ workspaceId }) =>
					operations.updateModel(workspaceId, params.providerId, params.modelId, payload).pipe(
						asHttpError(providerErrors),
						Effect.map((updated) => ({ updated })),
					),
				),
			)
			.handle("removeModel", ({ params }) =>
				Effect.flatMap(grantedWorkspace, ({ workspaceId }) =>
					operations
						.removeModel(workspaceId, params.providerId, params.modelId)
						.pipe(asHttpError(providerErrors)),
				),
			),
	);
}

const providerErrors = {
	ModelProviderNameConflict: Conflict,
	ModelProviderNotFound: NotFound,
	ModelProviderUrlNotAllowed: BadRequest,
	ProviderModelsRequireApiKey: BadRequest,
	ProviderActivationRequiresApiKey: BadRequest,
	ModelProviderRemovalNotAllowed: BadRequest,
	ProviderModelAlreadyConfigured: Conflict,
	FetchedModelCapabilitiesImmutable: BadRequest,
	ProviderModelNotFound: NotFound,
	ProviderModelRemovalNotAllowed: BadRequest,
};
