export * as ModelProviderSetup from "./model-provider-setup.ts";

import type {
	ChatgptSignInOutcome,
	ChatgptSignInStarted,
	ModelProvider,
	ModelProviderUpdate,
	NewModelProvider,
	ProviderModel,
	ProviderModelUpdate,
	WorkspaceModelsResponse,
} from "@sugabots/contracts";
import { presetSignsIn, providerLacksCredential, providerPreset } from "@sugabots/contracts";
import { Clock, Context, Data, Effect, Layer, Schema } from "effect";
import { Credentials } from "../../credentials/credentials.ts";
import { serviceOperations } from "../../database/database.ts";
import { type UserFacing, UserMessage } from "../../user-message.ts";
import type { AuthorizationDenied } from "../../workspaces/access.ts";
import { Authorization } from "../../workspaces/authorization.ts";
import type { CurrentActor } from "../../workspaces/current-actor.ts";
import { Egress } from "../network/egress.ts";
import { requireAllowedUrl, type UrlNotAllowed } from "../tested-configuration.ts";
import {
	CHATGPT_ISSUER,
	type ChatgptSignInFailed,
	type ChatgptTokens,
	redeemDeviceCode,
	requestDeviceCode,
} from "./chatgpt.ts";
import { ModelProbe } from "./model-probe.ts";
import { offeredModels, providerIn, providersIn } from "./model-provider-reads.ts";
import { ModelProviderRepository } from "./model-provider-repository.ts";
import { fetchProviderModels, type ModelDiscoveryFailed, testProvider } from "./remote.ts";

/**
 * Connecting a workspace to model providers: checking an address against the
 * egress policy before it is stored, learning what a provider offers, and
 * trying it before it is switched on. Configuring them takes the current
 * actor's `workspace.providers.manage`; seeing which models are offered takes
 * only `workspace.read`.
 */
export interface Interface {
	readonly list: (
		input: InWorkspace,
	) => Effect.Effect<ModelProvider[], AuthorizationDenied, CurrentActor.Service>;
	readonly listEnabledModels: (
		input: InWorkspace,
	) => Effect.Effect<WorkspaceModelsResponse, AuthorizationDenied, CurrentActor.Service>;
	readonly get: (
		input: InProvider,
	) => Effect.Effect<
		ModelProvider,
		AuthorizationDenied | ModelProviderNotFound,
		CurrentActor.Service
	>;
	/** Discovers the new provider's models straight away when it has a key. */
	readonly create: (
		input: InWorkspace & { provider: NewModelProvider },
	) => Effect.Effect<
		ModelProvider,
		| AuthorizationDenied
		| UrlNotAllowed
		| ModelProviderRepository.ModelProviderNameConflict
		| ModelProviderNotFound,
		CurrentActor.Service
	>;
	/**
	 * A new key sends the provider back through discovery, and switching it on
	 * tests it first; either way it is on only once it has answered.
	 */
	readonly update: (
		input: InProvider & { changes: ModelProviderUpdate },
	) => Effect.Effect<
		ModelProvider,
		AuthorizationDenied | ModelProviderNotFound | UrlNotAllowed | ProviderActivationRequiresApiKey,
		CurrentActor.Service
	>;
	readonly remove: (
		input: InProvider,
	) => Effect.Effect<
		void,
		AuthorizationDenied | ModelProviderRemovalNotAllowed,
		CurrentActor.Service
	>;
	/** Lists the provider's models, then asks an enabled one for a word, and records the result. */
	readonly test: (
		input: InProvider,
	) => Effect.Effect<
		TestOutcome,
		AuthorizationDenied | ModelProviderNotFound,
		CurrentActor.Service
	>;
	/** Asks ChatGPT for a code the person enters to sign the provider in. */
	readonly startChatgptSignIn: (
		input: InProvider,
	) => Effect.Effect<
		ChatgptSignInStarted,
		AuthorizationDenied | ModelProviderNotFound | ChatgptSignInNotOffered | ChatgptSignInFailed,
		CurrentActor.Service
	>;
	/**
	 * Asks whether the person has entered the code of `attempt`, from
	 * `startChatgptSignIn`; once they have, the provider is signed in and its
	 * models are discovered.
	 */
	readonly completeChatgptSignIn: (
		input: InProvider & { attempt: string },
	) => Effect.Effect<
		ChatgptSignInOutcome,
		| AuthorizationDenied
		| ModelProviderNotFound
		| ChatgptSignInNotOffered
		| ChatgptSignInAttemptInvalid
		| ChatgptSignInFailed,
		CurrentActor.Service
	>;
	readonly signOutChatgpt: (
		input: InProvider,
	) => Effect.Effect<
		ModelProvider,
		AuthorizationDenied | ModelProviderNotFound | ChatgptSignInNotOffered,
		CurrentActor.Service
	>;
	readonly fetchModels: (
		input: InProvider,
	) => Effect.Effect<
		{ added: number; updated: number; unchanged: number },
		AuthorizationDenied | ModelDiscoveryFailed,
		CurrentActor.Service
	>;
	readonly addModel: (
		input: InProvider & {
			model: Pick<ProviderModel, "modelId" | "capabilities"> &
				Partial<Pick<ProviderModel, "displayName" | "contextLength">>;
		},
	) => Effect.Effect<
		ModelProvider,
		| AuthorizationDenied
		| ModelProviderNotFound
		| ProviderModelsRequireApiKey
		| ProviderModelAlreadyConfigured,
		CurrentActor.Service
	>;
	readonly setModelsEnabled: (
		input: InProvider & { modelIds: string[]; enabled: boolean },
	) => Effect.Effect<
		number,
		AuthorizationDenied | ModelProviderNotFound | ProviderModelsRequireApiKey,
		CurrentActor.Service
	>;
	readonly updateModel: (
		input: InProvider & { modelId: string; changes: ProviderModelUpdate },
	) => Effect.Effect<
		number,
		| AuthorizationDenied
		| ModelProviderNotFound
		| ProviderModelsRequireApiKey
		| FetchedModelCapabilitiesImmutable
		| ProviderModelNotFound,
		CurrentActor.Service
	>;
	readonly removeModel: (
		input: InProvider & { modelId: string },
	) => Effect.Effect<
		void,
		AuthorizationDenied | ProviderModelRemovalNotAllowed,
		CurrentActor.Service
	>;
}

/** A workspace, by its id or its slug. */
export interface InWorkspace {
	workspace: string;
}

/** One of a workspace's model providers. */
export interface InProvider extends InWorkspace {
	providerId: string;
}

export class Service extends Context.Service<Service, Interface>()(
	"@sugabots/core/ModelProviderSetup",
) {}

export const make = Effect.gen(function* () {
	const operation = yield* serviceOperations<Interface>("ModelProviderSetup");
	const authorization = yield* Authorization.Service;
	const providers = yield* ModelProviderRepository.Service;
	const egress = yield* Egress.Service;
	const probe = yield* ModelProbe.Service;
	/** Seals a sign-in in progress; the same key as the stored credentials'. */
	const cipher = yield* Credentials.Service;
	const chatgptAuth = egress.providers.for({ baseUrl: CHATGPT_ISSUER });

	/** The id of the workspace `workspace` names, once the actor may configure its providers. */
	const managed = (workspace: string) =>
		Effect.map(
			authorization.workspace(workspace, "workspace.providers.manage"),
			({ workspaceId }) => workspaceId,
		);

	const requireProvider = (workspaceId: string, providerId: string) =>
		Effect.filterOrFail(
			providerIn(workspaceId, providerId),
			(provider) => provider !== undefined,
			() => new ModelProviderNotFound(),
		);

	const requireConnectedProvider = (workspaceId: string, providerId: string) =>
		requireProvider(workspaceId, providerId).pipe(
			Effect.filterOrFail(
				(provider) => !providerLacksCredential(provider),
				() => new ProviderModelsRequireApiKey(),
			),
		);

	const requireSignInProvider = (workspaceId: string, providerId: string) =>
		requireProvider(workspaceId, providerId).pipe(
			Effect.filterOrFail(
				(provider) => presetSignsIn(provider.preset),
				() => new ChatgptSignInNotOffered(),
			),
		);

	const sealSignInAttempt = (attempt: SignInAttempt) => cipher.encrypt(JSON.stringify(attempt));

	const openSignInAttempt = (sealed: string, workspaceId: string, providerId: string) =>
		Effect.gen(function* () {
			const now = yield* Clock.currentTimeMillis;
			return yield* Effect.try(() => JSON.parse(cipher.decrypt(sealed)) as unknown).pipe(
				Effect.flatMap(Schema.decodeUnknownEffect(SignInAttempt)),
				Effect.mapError(() => new ChatgptSignInAttemptInvalid()),
				Effect.filterOrFail(
					(attempt) =>
						attempt.workspaceId === workspaceId &&
						attempt.providerId === providerId &&
						attempt.expiresAt > now,
					() => new ChatgptSignInAttemptInvalid(),
				),
			);
		});

	/** Discovery whose failure is recorded on the provider and logged, rather than raised. */
	const discoverModelsQuietly = (
		workspaceId: string,
		providerId: string,
		activateOnSuccess: boolean,
	) =>
		fetchProviderModels(providers, workspaceId, providerId, egress.providers, {
			activateOnSuccess,
		}).pipe(Effect.catchTag("ModelDiscoveryFailed", () => Effect.void));

	const saveSignIn = (workspaceId: string, providerId: string, tokens: ChatgptTokens) =>
		Effect.gen(function* () {
			yield* providers.saveChatgptSignIn(workspaceId, providerId, tokens);
			yield* discoverModelsQuietly(workspaceId, providerId, true);
			return yield* requireProvider(workspaceId, providerId);
		});

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
		list: ({ workspace }) => operation("list", Effect.flatMap(managed(workspace), providersIn)),

		listEnabledModels: ({ workspace }) =>
			operation(
				"listEnabledModels",
				Effect.flatMap(authorization.workspace(workspace, "workspace.read"), ({ workspaceId }) =>
					offeredModels(workspaceId),
				),
			),

		get: ({ workspace, providerId }) =>
			operation(
				"get",
				Effect.flatMap(managed(workspace), (workspaceId) =>
					requireProvider(workspaceId, providerId),
				),
			),

		create: ({ workspace, provider }) =>
			operation(
				"create",
				Effect.gen(function* () {
					const { workspaceId, actor } = yield* authorization.workspace(
						workspace,
						"workspace.providers.manage",
					);
					yield* requireAllowedUrl(
						egress,
						provider.baseUrl ??
							("preset" in provider ? providerPreset(provider.preset).baseUrl : ""),
					);
					const created = yield* providers.create(workspaceId, {
						createdById: actor.userId,
						provider,
					});
					if (created.apiKeyEncrypted !== null) {
						yield* discoverModelsQuietly(workspaceId, created.id, true);
					}
					return yield* requireProvider(workspaceId, created.id);
				}),
			),

		update: ({ workspace, providerId, changes }) =>
			operation(
				"update",
				Effect.gen(function* () {
					const workspaceId = yield* managed(workspace);
					const current = yield* requireProvider(workspaceId, providerId);
					if (changes.baseUrl) {
						yield* requireAllowedUrl(egress, changes.baseUrl);
					}
					if (changes.active === true && providerLacksCredential(current) && !changes.apiKey) {
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

		remove: ({ workspace, providerId }) =>
			operation(
				"remove",
				Effect.gen(function* () {
					const workspaceId = yield* managed(workspace);
					if (!(yield* providers.remove(workspaceId, providerId))) {
						return yield* new ModelProviderRemovalNotAllowed();
					}
				}),
			),

		test: ({ workspace, providerId }) =>
			operation(
				"test",
				Effect.gen(function* () {
					const workspaceId = yield* managed(workspace);
					yield* requireProvider(workspaceId, providerId);
					const listed = yield* testProvider(providers, workspaceId, providerId, egress.providers);
					if (!listed.reachable) return listed;
					return yield* tryAnEnabledModel(workspaceId, providerId, listed);
				}),
			),

		startChatgptSignIn: ({ workspace, providerId }) =>
			operation(
				"startChatgptSignIn",
				Effect.gen(function* () {
					const workspaceId = yield* managed(workspace);
					yield* requireSignInProvider(workspaceId, providerId);
					const code = yield* requestDeviceCode(chatgptAuth);
					return {
						verificationUrl: code.verificationUrl,
						userCode: code.userCode,
						attempt: sealSignInAttempt({
							workspaceId,
							providerId,
							deviceAuthId: code.deviceAuthId,
							userCode: code.userCode,
							expiresAt: code.expiresAt,
						}),
						pollIntervalMs: code.pollIntervalMs,
						expiresAt: new Date(code.expiresAt).toISOString(),
					};
				}),
			),

		completeChatgptSignIn: ({ workspace, providerId, attempt: sealed }) =>
			operation(
				"completeChatgptSignIn",
				Effect.gen(function* () {
					const workspaceId = yield* managed(workspace);
					yield* requireSignInProvider(workspaceId, providerId);
					const attempt = yield* openSignInAttempt(sealed, workspaceId, providerId);
					const tokens = yield* redeemDeviceCode(chatgptAuth, attempt);
					if (!tokens) return { status: "pending" as const };
					return {
						status: "signed_in" as const,
						provider: yield* saveSignIn(workspaceId, providerId, tokens),
					};
				}),
			),

		signOutChatgpt: ({ workspace, providerId }) =>
			operation(
				"signOutChatgpt",
				Effect.gen(function* () {
					const workspaceId = yield* managed(workspace);
					yield* requireSignInProvider(workspaceId, providerId);
					yield* providers.saveChatgptSignIn(workspaceId, providerId, null);
					return yield* requireProvider(workspaceId, providerId);
				}),
			),

		fetchModels: ({ workspace, providerId }) =>
			operation(
				"fetchModels",
				Effect.flatMap(managed(workspace), (workspaceId) =>
					fetchProviderModels(providers, workspaceId, providerId, egress.providers),
				),
			),

		addModel: ({ workspace, providerId, model }) =>
			operation(
				"addModel",
				Effect.gen(function* () {
					const workspaceId = yield* managed(workspace);
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

		setModelsEnabled: ({ workspace, providerId, modelIds, enabled }) =>
			operation(
				"setModelsEnabled",
				Effect.gen(function* () {
					const workspaceId = yield* managed(workspace);
					yield* requireConnectedProvider(workspaceId, providerId);
					return yield* providers.setModelEnabled(workspaceId, providerId, modelIds, enabled);
				}),
			),

		updateModel: ({ workspace, providerId, modelId, changes }) =>
			operation(
				"updateModel",
				Effect.gen(function* () {
					const workspaceId = yield* managed(workspace);
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

		removeModel: ({ workspace, providerId, modelId }) =>
			operation(
				"removeModel",
				Effect.gen(function* () {
					const workspaceId = yield* managed(workspace);
					if (!(yield* providers.removeModel(workspaceId, providerId, modelId))) {
						return yield* new ProviderModelRemovalNotAllowed();
					}
				}),
			),
	});
});

export const layerNoDeps = Layer.effect(Service, make);

/** Needs a `ModelProbe`, which the conversations module implements. */
export const layer = layerNoDeps.pipe(
	Layer.provide([Authorization.layer, ModelProviderRepository.layer]),
);

/** A device code in progress, sealed and handed to the page so the server keeps no state for it. */
const SignInAttempt = Schema.Struct({
	workspaceId: Schema.String,
	providerId: Schema.String,
	deviceAuthId: Schema.String,
	userCode: Schema.String,
	expiresAt: Schema.Number,
});
type SignInAttempt = typeof SignInAttempt.Type;

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

export class ChatgptSignInNotOffered
	extends Data.TaggedError("ChatgptSignInNotOffered")
	implements UserFacing
{
	get userMessage() {
		return UserMessage.of`This provider is not signed in to with ChatGPT`;
	}
}

export class ChatgptSignInAttemptInvalid
	extends Data.TaggedError("ChatgptSignInAttemptInvalid")
	implements UserFacing
{
	get userMessage() {
		return UserMessage.of`This sign-in has expired; start again`;
	}
}
