import { BadRequest, Conflict, NotFound } from "@sugabots/contracts/http";
import { ModelProviderSetup } from "@sugabots/core/providers/model-providers/model-provider-setup";
import { Effect } from "effect";
import { HttpApiBuilder } from "effect/unstable/httpapi";
import { asSessionUser } from "../../auth/middleware.ts";
import { ServerApi } from "../../http/api.ts";
import { asHttpError, refusals } from "../../http/errors.ts";

export const modelProviderRoutes = HttpApiBuilder.group(ServerApi, "modelProviders", (handlers) =>
	Effect.gen(function* () {
		const providers = yield* ModelProviderSetup.Service;
		return handlers
			.handle("list", ({ params }) =>
				providers
					.list({ workspace: params.workspace })
					.pipe(asSessionUser, asHttpError(providerErrors)),
			)
			.handle("listEnabledModels", ({ params }) =>
				providers
					.listEnabledModels({ workspace: params.workspace })
					.pipe(asSessionUser, asHttpError(providerErrors)),
			)
			.handle("create", ({ params, payload }) =>
				providers
					.create({ workspace: params.workspace, provider: payload })
					.pipe(asSessionUser, asHttpError(providerErrors)),
			)
			.handle("get", ({ params }) =>
				providers.get(params).pipe(asSessionUser, asHttpError(providerErrors)),
			)
			.handle("update", ({ params, payload }) =>
				providers
					.update({ ...params, changes: payload })
					.pipe(asSessionUser, asHttpError(providerErrors)),
			)
			.handle("remove", ({ params }) =>
				providers.remove(params).pipe(asSessionUser, asHttpError(providerErrors)),
			)
			.handle("test", ({ params }) =>
				providers.test(params).pipe(asSessionUser, asHttpError(providerErrors)),
			)
			.handle("startChatgptSignIn", ({ params }) =>
				providers.startChatgptSignIn(params).pipe(asSessionUser, asHttpError(providerErrors)),
			)
			.handle("completeChatgptSignIn", ({ params, payload }) =>
				providers
					.completeChatgptSignIn({ ...params, attempt: payload.attempt })
					.pipe(asSessionUser, asHttpError(providerErrors)),
			)
			.handle("signOutChatgpt", ({ params }) =>
				providers.signOutChatgpt(params).pipe(asSessionUser, asHttpError(providerErrors)),
			)
			.handle("fetchModels", ({ params }) =>
				providers.fetchModels(params).pipe(asSessionUser, asHttpError(providerErrors)),
			)
			.handle("addModel", ({ params, payload }) =>
				providers
					.addModel({ ...params, model: payload })
					.pipe(asSessionUser, asHttpError(providerErrors)),
			)
			.handle("setModelsEnabled", ({ params, payload }) =>
				providers
					.setModelsEnabled({ ...params, modelIds: payload.modelIds, enabled: payload.enabled })
					.pipe(
						asSessionUser,
						asHttpError(providerErrors),
						Effect.map((updated) => ({ updated })),
					),
			)
			.handle("updateModel", ({ params, payload }) =>
				providers.updateModel({ ...params, changes: payload }).pipe(
					asSessionUser,
					asHttpError(providerErrors),
					Effect.map((updated) => ({ updated })),
				),
			)
			.handle("removeModel", ({ params }) =>
				providers.removeModel(params).pipe(asSessionUser, asHttpError(providerErrors)),
			);
	}),
);

const providerErrors = {
	...refusals,
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
	ChatgptSignInNotOffered: BadRequest,
	ChatgptSignInAttemptInvalid: BadRequest,
	ChatgptSignInFailed: BadRequest,
};
