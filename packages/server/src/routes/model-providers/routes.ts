import { BadRequest, Conflict, NotFound } from "@sugabots/contracts/http";
import { Effect } from "effect";
import { HttpApiBuilder } from "effect/unstable/httpapi";
import { operationCaller } from "../../auth/middleware.ts";
import { ServerApi } from "../../http/api.ts";
import { asHttpError, refusals } from "../../http/errors.ts";

/** A workspace's model providers and the models they offer, each endpoint its operation. */
export const modelProviderRoutes = HttpApiBuilder.group(ServerApi, "modelProviders", (handlers) =>
	Effect.map(operationCaller, (callOperation) =>
		handlers
			.handle("list", ({ params }) =>
				callOperation("modelProviders.list", params).pipe(asHttpError(providerErrors)),
			)
			.handle("listEnabledModels", ({ params }) =>
				callOperation("modelProviders.listEnabledModels", params).pipe(asHttpError(providerErrors)),
			)
			.handle("setDefaultModel", ({ params, payload }) =>
				callOperation("modelProviders.setDefaultModel", { ...params, ...payload }).pipe(
					asHttpError(providerErrors),
				),
			)
			.handle("create", ({ params, payload }) =>
				callOperation("modelProviders.create", { ...params, provider: payload }).pipe(
					asHttpError(providerErrors),
				),
			)
			.handle("update", ({ params, payload }) =>
				callOperation("modelProviders.update", { ...params, changes: payload }).pipe(
					asHttpError(providerErrors),
				),
			)
			.handle("remove", ({ params }) =>
				callOperation("modelProviders.remove", params).pipe(asHttpError(providerErrors)),
			)
			.handle("switchOff", ({ params, payload }) =>
				callOperation("modelProviders.switchOff", { ...params, ...payload }).pipe(
					asHttpError(providerErrors),
				),
			)
			.handle("test", ({ params }) =>
				callOperation("modelProviders.test", params).pipe(asHttpError(providerErrors)),
			)
			.handle("startSignIn", ({ params }) =>
				callOperation("modelProviders.startSignIn", params).pipe(asHttpError(providerErrors)),
			)
			.handle("completeSignIn", ({ params, payload }) =>
				callOperation("modelProviders.completeSignIn", { ...params, ...payload }).pipe(
					asHttpError(providerErrors),
				),
			)
			.handle("signOut", ({ params }) =>
				callOperation("modelProviders.signOut", params).pipe(asHttpError(providerErrors)),
			)
			.handle("discoverModels", ({ params }) =>
				callOperation("modelProviders.discoverModels", params).pipe(asHttpError(providerErrors)),
			)
			.handle("addModel", ({ params, payload }) =>
				callOperation("modelProviders.addModel", { ...params, model: payload }).pipe(
					asHttpError(providerErrors),
				),
			)
			.handle("updateModel", ({ params, payload }) =>
				callOperation("modelProviders.updateModel", { ...params, changes: payload }).pipe(
					asHttpError(providerErrors),
				),
			)
			.handle("switchOffModel", ({ params, payload }) =>
				callOperation("modelProviders.switchOffModel", { ...params, ...payload }).pipe(
					asHttpError(providerErrors),
				),
			),
	),
);

/** What each way a model providers operation can fail means over HTTP. */
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
