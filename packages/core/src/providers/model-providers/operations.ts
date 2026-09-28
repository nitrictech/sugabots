import type {
	ModelProviderUpdate,
	NewModelProvider,
	ProviderModel,
	ProviderModelUpdate,
} from "@sugabots/contracts";
import { presetRequiresApiKey, providerPreset } from "@sugabots/contracts";
import { Data, Effect } from "effect";
import type { TurnModel } from "../../conversations/turns/model.ts";
import { probeModel } from "../../conversations/turns/model.ts";
import type { Database } from "../../database/database.ts";
import { type UserFacing, UserMessage } from "../../user-message.ts";
import type { EgressHttpClients, EgressUrlValidator } from "../network/egress.ts";
import { fetchProviderModels, testProvider } from "./remote.ts";
import type { ModelProviderStore } from "./store.ts";

export class ModelProviderNotFound
	extends Data.TaggedError("ModelProviderNotFound")
	implements UserFacing
{
	get userMessage() {
		return UserMessage.of`No such model provider`;
	}
}

export class ModelProviderUrlNotAllowed
	extends Data.TaggedError("ModelProviderUrlNotAllowed")
	implements UserFacing
{
	get userMessage() {
		return UserMessage.of`Provider URL is not allowed by the network policy`;
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

export interface ProviderTestOutcome {
	reachable: boolean;
	latencyMs: number;
	error?: UserMessage;
}

export function modelProviderOperations({
	providers,
	httpClients,
	validateProviderUrl,
	model,
}: {
	providers: ModelProviderStore;
	httpClients: EgressHttpClients;
	validateProviderUrl: EgressUrlValidator;
	model: TurnModel;
}) {
	const requireProvider = (workspaceId: string, providerId: string) =>
		Effect.filterOrFail(
			providers.get(workspaceId, providerId),
			(provider) => provider != null,
			() => new ModelProviderNotFound(),
		);

	const requireConnectedProvider = (workspaceId: string, providerId: string) =>
		requireProvider(workspaceId, providerId).pipe(
			Effect.filterOrFail(
				(provider) => !presetRequiresApiKey(provider.preset) || provider.hasApiKey,
				() => new ProviderModelsRequireApiKey(),
			),
		);

	const requireAllowedUrl = (baseUrl: string) =>
		Effect.tryPromise({
			try: () => validateProviderUrl(baseUrl),
			catch: () => new ModelProviderUrlNotAllowed(),
		});

	const discoverModelsQuietly = (
		workspaceId: string,
		providerId: string,
		activateOnSuccess: boolean,
	) =>
		fetchProviderModels(providers, workspaceId, providerId, httpClients, {
			activateOnSuccess,
		}).pipe(Effect.catchCause(() => Effect.void));

	const tryAnEnabledModel = (
		workspaceId: string,
		providerId: string,
		listed: ProviderTestOutcome,
	) =>
		Effect.gen(function* () {
			const provider = yield* requireProvider(workspaceId, providerId);
			const enabled = provider.models.find((candidate) => candidate.enabled);
			if (!provider.active || !enabled) return listed;

			const connection = yield* providers.connection(workspaceId, providerId);
			const started = Date.now();
			const answered = yield* probeModel(model, workspaceId, enabled.modelId).pipe(Effect.result);
			if (answered._tag === "Success") {
				return { ...listed, latencyMs: listed.latencyMs + (Date.now() - started) };
			}

			const error = UserMessage.of`${UserMessage.unchecked(enabled.modelId)}: ${answered.failure.userMessage}`;
			if (connection) {
				yield* providers.recordTest(workspaceId, providerId, connection.configurationUpdatedAt, {
					error,
				});
			}
			return { reachable: false, latencyMs: listed.latencyMs + (Date.now() - started), error };
		});

	return {
		list: (workspaceId: string) => providers.list(workspaceId),
		listEnabled: (workspaceId: string) => providers.listEnabled(workspaceId),
		get: requireProvider,

		create: (workspaceId: string, userId: string, input: NewModelProvider) =>
			Effect.gen(function* () {
				yield* requireAllowedUrl(
					input.baseUrl ?? ("preset" in input ? providerPreset(input.preset).baseUrl : ""),
				);
				const provider = yield* providers.create(workspaceId, userId, input);
				if (provider.hasApiKey) {
					yield* discoverModelsQuietly(workspaceId, provider.id, true);
				}
				return yield* requireProvider(workspaceId, provider.id);
			}),

		update: (workspaceId: string, providerId: string, input: ModelProviderUpdate) =>
			Effect.gen(function* () {
				const current = yield* requireProvider(workspaceId, providerId);
				if (input.baseUrl) {
					yield* requireAllowedUrl(input.baseUrl);
				}
				if (
					input.active &&
					presetRequiresApiKey(current.preset) &&
					!current.hasApiKey &&
					!input.apiKey
				) {
					return yield* new ProviderActivationRequiresApiKey();
				}
				const updated = yield* providers.update(workspaceId, providerId, {
					...input,
					active: input.active === true ? false : input.active,
				});
				if (!updated) {
					return yield* new ModelProviderNotFound();
				}
				if (input.apiKey) {
					yield* discoverModelsQuietly(workspaceId, providerId, input.active !== false);
				} else if (input.active === true) {
					yield* testProvider(providers, workspaceId, providerId, httpClients);
				} else {
					return updated;
				}
				return yield* requireProvider(workspaceId, providerId);
			}),

		remove: (workspaceId: string, providerId: string) =>
			Effect.filterOrFail(
				providers.remove(workspaceId, providerId),
				(removed) => removed,
				() => new ModelProviderRemovalNotAllowed(),
			).pipe(Effect.asVoid),

		test: (
			workspaceId: string,
			providerId: string,
		): Effect.Effect<ProviderTestOutcome, ModelProviderNotFound, Database> =>
			Effect.gen(function* () {
				yield* requireProvider(workspaceId, providerId);
				const listed = yield* testProvider(providers, workspaceId, providerId, httpClients);
				if (!listed.reachable) return listed;
				return yield* tryAnEnabledModel(workspaceId, providerId, listed);
			}),

		fetchModels: (workspaceId: string, providerId: string) =>
			fetchProviderModels(providers, workspaceId, providerId, httpClients).pipe(Effect.orDie),

		addModel: (
			workspaceId: string,
			providerId: string,
			input: Pick<ProviderModel, "modelId" | "capabilities"> &
				Partial<Pick<ProviderModel, "displayName" | "contextLength">>,
		) =>
			Effect.gen(function* () {
				yield* requireConnectedProvider(workspaceId, providerId);
				const added = yield* providers.addModels(workspaceId, providerId, [
					{
						...input,
						displayName: input.displayName ?? null,
						contextLength: input.contextLength ?? null,
						source: "manual",
					},
				]);
				if (added === 0) {
					return yield* new ProviderModelAlreadyConfigured();
				}
				return yield* requireProvider(workspaceId, providerId);
			}),

		setModelsEnabled: (
			workspaceId: string,
			providerId: string,
			modelIds: string[],
			enabled: boolean,
		) =>
			Effect.andThen(
				requireConnectedProvider(workspaceId, providerId),
				providers.setModelEnabled(workspaceId, providerId, modelIds, enabled),
			),

		updateModel: (
			workspaceId: string,
			providerId: string,
			modelId: string,
			input: ProviderModelUpdate,
		) =>
			Effect.gen(function* () {
				const provider = yield* requireConnectedProvider(workspaceId, providerId);
				const configured = provider.models.find((candidate) => candidate.id === modelId);
				if (input.capabilities !== undefined && configured?.source === "fetched") {
					return yield* new FetchedModelCapabilitiesImmutable();
				}
				const updated = yield* providers.updateModel(workspaceId, providerId, modelId, input);
				if (updated === 0) {
					return yield* new ProviderModelNotFound();
				}
				return updated;
			}),

		removeModel: (workspaceId: string, providerId: string, modelId: string) =>
			Effect.filterOrFail(
				providers.removeModel(workspaceId, providerId, modelId),
				(removed) => removed,
				() => new ProviderModelRemovalNotAllowed(),
			).pipe(Effect.asVoid),
	};
}
