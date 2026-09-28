import { BadRequest, Conflict, NotFound } from "@sugabots/contracts/http";
import { ModelProviderSetup } from "@sugabots/core/providers/model-providers/model-provider-setup";
import { Effect } from "effect";
import { HttpApiBuilder } from "effect/unstable/httpapi";
import { ServerApi } from "../../http/api.ts";
import { grantedWorkspace } from "../../http/authorisation.ts";
import { asHttpError } from "../../http/errors.ts";

export const modelProviderRoutes = HttpApiBuilder.group(ServerApi, "modelProviders", (handlers) =>
	Effect.gen(function* () {
		const providers = yield* ModelProviderSetup.Service;
		return handlers
			.handle("list", () =>
				Effect.flatMap(grantedWorkspace, ({ workspaceId }) => providers.list(workspaceId)),
			)
			.handle("listEnabledModels", () =>
				Effect.flatMap(grantedWorkspace, ({ workspaceId }) =>
					providers.listEnabledModels(workspaceId),
				),
			)
			.handle("create", ({ payload }) =>
				Effect.flatMap(grantedWorkspace, ({ workspaceId, actor }) =>
					providers
						.create({ workspaceId, createdById: actor.userId, provider: payload })
						.pipe(asHttpError(providerErrors)),
				),
			)
			.handle("get", ({ params }) =>
				Effect.flatMap(grantedWorkspace, ({ workspaceId }) =>
					providers
						.get({ workspaceId, providerId: params.providerId })
						.pipe(asHttpError(providerErrors)),
				),
			)
			.handle("update", ({ params, payload }) =>
				Effect.flatMap(grantedWorkspace, ({ workspaceId }) =>
					providers
						.update({ workspaceId, providerId: params.providerId, changes: payload })
						.pipe(asHttpError(providerErrors)),
				),
			)
			.handle("remove", ({ params }) =>
				Effect.flatMap(grantedWorkspace, ({ workspaceId }) =>
					providers
						.remove({ workspaceId, providerId: params.providerId })
						.pipe(asHttpError(providerErrors)),
				),
			)
			.handle("test", ({ params }) =>
				Effect.flatMap(grantedWorkspace, ({ workspaceId }) =>
					providers
						.test({ workspaceId, providerId: params.providerId })
						.pipe(asHttpError(providerErrors)),
				),
			)
			.handle("fetchModels", ({ params }) =>
				Effect.flatMap(grantedWorkspace, ({ workspaceId }) =>
					providers
						.fetchModels({ workspaceId, providerId: params.providerId })
						.pipe(asHttpError(providerErrors)),
				),
			)
			.handle("addModel", ({ params, payload }) =>
				Effect.flatMap(grantedWorkspace, ({ workspaceId }) =>
					providers
						.addModel({ workspaceId, providerId: params.providerId, model: payload })
						.pipe(asHttpError(providerErrors)),
				),
			)
			.handle("setModelsEnabled", ({ params, payload }) =>
				Effect.flatMap(grantedWorkspace, ({ workspaceId }) =>
					providers
						.setModelsEnabled({
							workspaceId,
							providerId: params.providerId,
							modelIds: payload.modelIds,
							enabled: payload.enabled,
						})
						.pipe(
							asHttpError(providerErrors),
							Effect.map((updated) => ({ updated })),
						),
				),
			)
			.handle("updateModel", ({ params, payload }) =>
				Effect.flatMap(grantedWorkspace, ({ workspaceId }) =>
					providers
						.updateModel({
							workspaceId,
							providerId: params.providerId,
							modelId: params.modelId,
							changes: payload,
						})
						.pipe(
							asHttpError(providerErrors),
							Effect.map((updated) => ({ updated })),
						),
				),
			)
			.handle("removeModel", ({ params }) =>
				Effect.flatMap(grantedWorkspace, ({ workspaceId }) =>
					providers
						.removeModel({ workspaceId, providerId: params.providerId, modelId: params.modelId })
						.pipe(asHttpError(providerErrors)),
				),
			);
	}),
);

const providerErrors = {
	ModelProviderNameConflict: Conflict,
	ModelProviderNotFound: NotFound,
	UrlNotAllowed: BadRequest,
	ProviderModelsRequireApiKey: BadRequest,
	ProviderActivationRequiresApiKey: BadRequest,
	ModelProviderRemovalNotAllowed: BadRequest,
	ProviderModelAlreadyConfigured: Conflict,
	FetchedModelCapabilitiesImmutable: BadRequest,
	ProviderModelNotFound: NotFound,
	ProviderModelRemovalNotAllowed: BadRequest,
	ModelDiscoveryFailed: BadRequest,
};
