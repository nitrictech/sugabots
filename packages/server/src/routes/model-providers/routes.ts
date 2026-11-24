import { BadRequest, Conflict, NotFound } from "@sugabots/contracts/http";
import { ModelProviderSetup } from "@sugabots/core/providers/model-providers/model-provider-setup";
import { Effect } from "effect";
import { HttpApiBuilder } from "effect/unstable/httpapi";
import { asCurrentUser } from "../../auth/middleware.ts";
import { ServerApi } from "../../http/api.ts";
import { asHttpError, refusals } from "../../http/errors.ts";

export const modelProviderRoutes = HttpApiBuilder.group(ServerApi, "modelProviders", (handlers) =>
	Effect.gen(function* () {
		const providers = yield* ModelProviderSetup.Service;
		return handlers
			.handle("list", ({ params }) =>
				providers
					.list({ workspace: params.workspace })
					.pipe(asCurrentUser, asHttpError(providerErrors)),
			)
			.handle("listEnabledModels", ({ params }) =>
				providers
					.listEnabledModels({ workspace: params.workspace })
					.pipe(asCurrentUser, asHttpError(providerErrors)),
			)
			.handle("setDefaultModel", ({ params, payload }) =>
				providers
					.setDefaultModel({ workspace: params.workspace, model: payload.model })
					.pipe(asCurrentUser, asHttpError(providerErrors)),
			)
			.handle("create", ({ params, payload }) =>
				providers
					.create({ workspace: params.workspace, provider: payload })
					.pipe(asCurrentUser, asHttpError(providerErrors)),
			)
			.handle("update", ({ params, payload }) =>
				providers
					.update({ ...params, changes: payload })
					.pipe(asCurrentUser, asHttpError(providerErrors)),
			)
			.handle("remove", ({ params }) =>
				providers.remove(params).pipe(asCurrentUser, asHttpError(providerErrors)),
			)
			.handle("switchOff", ({ params, payload }) =>
				providers
					.switchOff({ ...params, ...payload })
					.pipe(asCurrentUser, asHttpError(providerErrors), Effect.asVoid),
			)
			.handle("test", ({ params }) =>
				providers.test(params).pipe(asCurrentUser, asHttpError(providerErrors)),
			)
			.handle("startSignIn", ({ params }) =>
				providers.startSignIn(params).pipe(asCurrentUser, asHttpError(providerErrors)),
			)
			.handle("completeSignIn", ({ params, payload }) =>
				providers
					.completeSignIn({ ...params, attempt: payload.attempt })
					.pipe(asCurrentUser, asHttpError(providerErrors)),
			)
			.handle("signOut", ({ params }) =>
				providers.signOut(params).pipe(asCurrentUser, asHttpError(providerErrors)),
			)
			.handle("discoverModels", ({ params }) =>
				providers
					.discoverModels(params)
					.pipe(asCurrentUser, asHttpError(providerErrors), Effect.asVoid),
			)
			.handle("addModel", ({ params, payload }) =>
				providers
					.addModel({ ...params, model: payload })
					.pipe(asCurrentUser, asHttpError(providerErrors)),
			)
			.handle("updateModel", ({ params, payload }) =>
				providers
					.updateModel({ ...params, changes: payload })
					.pipe(asCurrentUser, asHttpError(providerErrors), Effect.asVoid),
			)
			.handle("switchOffModel", ({ params, payload }) =>
				providers
					.switchOffModel({ ...params, ...payload })
					.pipe(asCurrentUser, asHttpError(providerErrors), Effect.asVoid),
			);
	}),
);

const providerErrors = {
	...refusals,
	ModelProviderNameConflict: Conflict,
	ModelProviderNotFound: NotFound,
	UrlNotAllowed: BadRequest,
	ProviderModelsRequireCredential: BadRequest,
	ProviderActivationRequiresCredential: BadRequest,
	ModelProviderRemovalNotAllowed: BadRequest,
	ProviderModelAlreadyConfigured: Conflict,
	FetchedModelCapabilitiesImmutable: BadRequest,
	ProviderModelNotFound: NotFound,
	DiscoveryCredentialsMissing: BadRequest,
	DiscoveryCredentialsRejected: BadRequest,
	DiscoverySignInLapsed: BadRequest,
	DiscoveryUnavailable: BadRequest,
	DiscoveryUnreachable: BadRequest,
	DiscoveryAddressRefused: BadRequest,
	ModelListUnreadable: BadRequest,
	ModelListTooLarge: BadRequest,
	ProviderSignInNotOffered: BadRequest,
	ProviderSignInAttemptInvalid: BadRequest,
	ProviderSignInFailed: BadRequest,
	ModelInUse: Conflict,
	ModelNotEnabled: BadRequest,
};
