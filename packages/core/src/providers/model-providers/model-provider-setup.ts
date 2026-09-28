export * as ModelProviderSetup from "./model-provider-setup.ts";

import type {
	ModelProvider,
	ModelProviderUpdate,
	NewModelProvider,
	ProviderModel,
	ProviderModelUpdate,
	WorkspaceModelsResponse,
} from "@sugabots/contracts";
import { presetRequiresApiKey, providerPreset } from "@sugabots/contracts";
import { Clock, Context, Data, Effect, Layer } from "effect";
import { serviceOperations } from "../../database/database.ts";
import { type UserFacing, UserMessage } from "../../user-message.ts";
import { Egress } from "../network/egress.ts";
import { requireAllowedUrl, type UrlNotAllowed } from "../tested-configuration.ts";
import { ModelProbe } from "./model-probe.ts";
import { offeredModels, providerIn, providersIn } from "./model-provider-reads.ts";
import { ModelProviderRepository } from "./model-provider-repository.ts";
import { fetchProviderModels, type ModelDiscoveryFailed, testProvider } from "./remote.ts";

/**
 * Connecting a workspace to model providers: checking an address against the
 * egress policy before it is stored, learning what a provider offers, and
 * trying it before it is switched on.
 */
export interface Interface {
	readonly list: (workspaceId: string) => Effect.Effect<ModelProvider[]>;
	readonly listEnabledModels: (workspaceId: string) => Effect.Effect<WorkspaceModelsResponse>;
	readonly get: (input: InProvider) => Effect.Effect<ModelProvider, ModelProviderNotFound>;
	/** Discovers the new provider's models straight away when it has a key. */
	readonly create: (input: {
		workspaceId: string;
		createdById: string;
		provider: NewModelProvider;
	}) => Effect.Effect<
		ModelProvider,
		UrlNotAllowed | ModelProviderRepository.ModelProviderNameConflict | ModelProviderNotFound
	>;
	/**
	 * A new key sends the provider back through discovery, and switching it on
	 * tests it first; either way it is on only once it has answered.
	 */
	readonly update: (
		input: InProvider & { changes: ModelProviderUpdate },
	) => Effect.Effect<
		ModelProvider,
		ModelProviderNotFound | UrlNotAllowed | ProviderActivationRequiresApiKey
	>;
	readonly remove: (input: InProvider) => Effect.Effect<void, ModelProviderRemovalNotAllowed>;
	/** Lists the provider's models, then asks an enabled one for a word, and records the result. */
	readonly test: (input: InProvider) => Effect.Effect<TestOutcome, ModelProviderNotFound>;
	readonly fetchModels: (
		input: InProvider,
	) => Effect.Effect<{ added: number; updated: number; unchanged: number }, ModelDiscoveryFailed>;
	readonly addModel: (
		input: InProvider & {
			model: Pick<ProviderModel, "modelId" | "capabilities"> &
				Partial<Pick<ProviderModel, "displayName" | "contextLength">>;
		},
	) => Effect.Effect<
		ModelProvider,
		ModelProviderNotFound | ProviderModelsRequireApiKey | ProviderModelAlreadyConfigured
	>;
	readonly setModelsEnabled: (
		input: InProvider & { modelIds: string[]; enabled: boolean },
	) => Effect.Effect<number, ModelProviderNotFound | ProviderModelsRequireApiKey>;
	readonly updateModel: (
		input: InProvider & { modelId: string; changes: ProviderModelUpdate },
	) => Effect.Effect<
		number,
		| ModelProviderNotFound
		| ProviderModelsRequireApiKey
		| FetchedModelCapabilitiesImmutable
		| ProviderModelNotFound
	>;
	readonly removeModel: (
		input: InProvider & { modelId: string },
	) => Effect.Effect<void, ProviderModelRemovalNotAllowed>;
}

/** One of a workspace's model providers. */
export interface InProvider {
	workspaceId: string;
	providerId: string;
}

export class Service extends Context.Service<Service, Interface>()(
	"@sugabots/core/ModelProviderSetup",
) {}

export const make = Effect.gen(function* () {
	const operation = yield* serviceOperations<Interface>("ModelProviderSetup");
	const providers = yield* ModelProviderRepository.Service;
	const egress = yield* Egress.Service;
	const probe = yield* ModelProbe.Service;

	const requireProvider = (workspaceId: string, providerId: string) =>
		Effect.filterOrFail(
			providerIn(workspaceId, providerId),
			(provider) => provider !== undefined,
			() => new ModelProviderNotFound(),
		);

	const requireConnectedProvider = (workspaceId: string, providerId: string) =>
		requireProvider(workspaceId, providerId).pipe(
			Effect.filterOrFail(
				(provider) => !presetRequiresApiKey(provider.preset) || provider.hasApiKey,
				() => new ProviderModelsRequireApiKey(),
			),
		);

	/** Discovery whose failure is recorded on the provider and logged, rather than raised. */
	const discoverModelsQuietly = (
		workspaceId: string,
		providerId: string,
		activateOnSuccess: boolean,
	) =>
		fetchProviderModels(providers, workspaceId, providerId, egress.providers, {
			activateOnSuccess,
		}).pipe(Effect.catchTag("ModelDiscoveryFailed", () => Effect.void));

	const tryAnEnabledModel = (workspaceId: string, providerId: string, listed: TestOutcome) =>
		Effect.gen(function* () {
			const provider = yield* requireProvider(workspaceId, providerId);
			const enabled = provider.models.find((candidate) => candidate.enabled);
			if (!provider.active || !enabled) return listed;

			const endpoint = yield* providers.endpoint(workspaceId, providerId);
			const started = yield* Clock.currentTimeMillis;
			const answered = yield* probe.probe(workspaceId, enabled.modelId).pipe(Effect.result);
			const latencyMs = listed.latencyMs + ((yield* Clock.currentTimeMillis) - started);
			if (answered._tag === "Success") {
				return { ...listed, latencyMs };
			}

			yield* Effect.logWarning("Trying a model provider's model failed", answered.failure.message);
			// A model id is the provider's own name for the model, shown to the
			// administrator who enabled it.
			const error = UserMessage.of`${UserMessage.unchecked(enabled.modelId)}: ${answered.failure.userMessage}`;
			if (endpoint) {
				yield* providers.recordTest(workspaceId, providerId, endpoint.configurationUpdatedAt, {
					error,
				});
			}
			return { reachable: false, latencyMs, error };
		});

	return Service.of({
		list: (workspaceId) => operation("list", providersIn(workspaceId)),

		listEnabledModels: (workspaceId) => operation("listEnabledModels", offeredModels(workspaceId)),

		get: ({ workspaceId, providerId }) =>
			operation("get", requireProvider(workspaceId, providerId)),

		create: ({ workspaceId, createdById, provider }) =>
			operation(
				"create",
				Effect.gen(function* () {
					yield* requireAllowedUrl(
						egress,
						provider.baseUrl ??
							("preset" in provider ? providerPreset(provider.preset).baseUrl : ""),
					);
					const created = yield* providers.create(workspaceId, { createdById, provider });
					if (created.apiKeyEncrypted !== null) {
						yield* discoverModelsQuietly(workspaceId, created.id, true);
					}
					return yield* requireProvider(workspaceId, created.id);
				}),
			),

		update: ({ workspaceId, providerId, changes }) =>
			operation(
				"update",
				Effect.gen(function* () {
					const current = yield* requireProvider(workspaceId, providerId);
					if (changes.baseUrl) {
						yield* requireAllowedUrl(egress, changes.baseUrl);
					}
					if (
						changes.active === true &&
						presetRequiresApiKey(current.preset) &&
						!current.hasApiKey &&
						!changes.apiKey
					) {
						return yield* new ProviderActivationRequiresApiKey();
					}
					// Switching on is a test's to do, below, so it is not written here.
					const updated = yield* providers.update(workspaceId, providerId, {
						...changes,
						active: changes.active === false ? false : undefined,
					});
					if (!updated) {
						return yield* new ModelProviderNotFound();
					}
					if (changes.apiKey) {
						yield* discoverModelsQuietly(workspaceId, providerId, changes.active !== false);
					} else if (changes.active === true) {
						yield* testProvider(providers, workspaceId, providerId, egress.providers);
					}
					return yield* requireProvider(workspaceId, providerId);
				}),
			),

		remove: ({ workspaceId, providerId }) =>
			operation(
				"remove",
				Effect.filterOrFail(
					providers.remove(workspaceId, providerId),
					(removed) => removed,
					() => new ModelProviderRemovalNotAllowed(),
				).pipe(Effect.asVoid),
			),

		test: ({ workspaceId, providerId }) =>
			operation(
				"test",
				Effect.gen(function* () {
					yield* requireProvider(workspaceId, providerId);
					const listed = yield* testProvider(providers, workspaceId, providerId, egress.providers);
					if (!listed.reachable) return listed;
					return yield* tryAnEnabledModel(workspaceId, providerId, listed);
				}),
			),

		fetchModels: ({ workspaceId, providerId }) =>
			operation(
				"fetchModels",
				fetchProviderModels(providers, workspaceId, providerId, egress.providers),
			),

		addModel: ({ workspaceId, providerId, model }) =>
			operation(
				"addModel",
				Effect.gen(function* () {
					yield* requireConnectedProvider(workspaceId, providerId);
					const added = yield* providers.addModels(workspaceId, providerId, [
						{
							...model,
							displayName: model.displayName ?? null,
							contextLength: model.contextLength ?? null,
							source: "manual",
						},
					]);
					if (added === 0) {
						return yield* new ProviderModelAlreadyConfigured();
					}
					return yield* requireProvider(workspaceId, providerId);
				}),
			),

		setModelsEnabled: ({ workspaceId, providerId, modelIds, enabled }) =>
			operation(
				"setModelsEnabled",
				Effect.andThen(
					requireConnectedProvider(workspaceId, providerId),
					providers.setModelEnabled(workspaceId, providerId, modelIds, enabled),
				),
			),

		updateModel: ({ workspaceId, providerId, modelId, changes }) =>
			operation(
				"updateModel",
				Effect.gen(function* () {
					const provider = yield* requireConnectedProvider(workspaceId, providerId);
					const configured = provider.models.find((candidate) => candidate.id === modelId);
					if (changes.capabilities !== undefined && configured?.source === "fetched") {
						return yield* new FetchedModelCapabilitiesImmutable();
					}
					const updated = yield* providers.updateModel(workspaceId, providerId, modelId, changes);
					if (updated === 0) {
						return yield* new ProviderModelNotFound();
					}
					return updated;
				}),
			),

		removeModel: ({ workspaceId, providerId, modelId }) =>
			operation(
				"removeModel",
				Effect.filterOrFail(
					providers.removeModel(workspaceId, providerId, modelId),
					(removed) => removed,
					() => new ProviderModelRemovalNotAllowed(),
				).pipe(Effect.asVoid),
			),
	});
});

export const layerNoDeps = Layer.effect(Service, make);

/** Needs a `ModelProbe`, which the conversations module implements. */
export const layer = layerNoDeps.pipe(Layer.provide(ModelProviderRepository.layer));

export interface TestOutcome {
	reachable: boolean;
	latencyMs: number;
	error?: UserMessage;
}

export class ModelProviderNotFound
	extends Data.TaggedError("ModelProviderNotFound")
	implements UserFacing
{
	get userMessage() {
		return UserMessage.of`No such model provider`;
	}
}

export class ProviderModelsRequireApiKey
	extends Data.TaggedError("ProviderModelsRequireApiKey")
	implements UserFacing
{
	get userMessage() {
		return UserMessage.of`Add an API key before managing models`;
	}
}

export class ProviderActivationRequiresApiKey
	extends Data.TaggedError("ProviderActivationRequiresApiKey")
	implements UserFacing
{
	get userMessage() {
		return UserMessage.of`Add an API key before activating this provider`;
	}
}

export class ModelProviderRemovalNotAllowed
	extends Data.TaggedError("ModelProviderRemovalNotAllowed")
	implements UserFacing
{
	get userMessage() {
		return UserMessage.of`Only custom providers can be removed`;
	}
}

export class ProviderModelAlreadyConfigured
	extends Data.TaggedError("ProviderModelAlreadyConfigured")
	implements UserFacing
{
	get userMessage() {
		return UserMessage.of`That model is already configured in this workspace`;
	}
}

export class FetchedModelCapabilitiesImmutable
	extends Data.TaggedError("FetchedModelCapabilitiesImmutable")
	implements UserFacing
{
	get userMessage() {
		return UserMessage.of`The provider says what this model can do; switch capabilities off instead`;
	}
}

export class ProviderModelNotFound
	extends Data.TaggedError("ProviderModelNotFound")
	implements UserFacing
{
	get userMessage() {
		return UserMessage.of`No such provider model`;
	}
}

export class ProviderModelRemovalNotAllowed
	extends Data.TaggedError("ProviderModelRemovalNotAllowed")
	implements UserFacing
{
	get userMessage() {
		return UserMessage.of`Only manually added models can be removed`;
	}
}
