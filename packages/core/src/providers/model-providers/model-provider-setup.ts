export * as ModelProviderSetup from "./model-provider-setup.ts";

import type {
	ModelProvider,
	ModelProviderUpdate,
	NewModelProvider,
	ProviderModel,
	ProviderModelUpdate,
	ProviderPresetId,
	ProviderSignInOutcome,
	ProviderSignInStarted,
	WorkspaceModelsResponse,
} from "@sugabots/contracts";
import {
	presetSignInService,
	providerLacksCredential,
	providerPreset,
	type SignInServiceId,
	signInServiceNames,
} from "@sugabots/contracts";
import { Clock, Context, Data, DateTime, Effect, Layer, Schema } from "effect";
import type { AuthorizationDenied } from "../../authorization/access.ts";
import { Authorization } from "../../authorization/authorization.ts";
import type { CurrentActor } from "../../authorization/current-actor.ts";
import { Credentials } from "../../credentials/credentials.ts";
import { serviceOperations } from "../../database/database.ts";
import { type UserFacing, UserMessage } from "../../user-message.ts";
import { AgentRepository } from "../../workspaces/agents/agent-repository.ts";
import { Models } from "../models/models.ts";
import { Egress } from "../network/egress.ts";
import { requireAllowedUrl, type UrlNotAllowed } from "../tested-configuration.ts";
import {
	holdingModel,
	keepingHeldModelsOffered,
	type ModelInUse,
	withHeldModelsLocked,
} from "./held-models.ts";
import { offeredModels, providerIn, providersIn } from "./model-provider-reads.ts";
import { ModelProviderRepository } from "./model-provider-repository.ts";
import { fetchProviderModels, type ModelDiscoveryFailed, testProvider } from "./remote.ts";
import {
	type OAuthTokens,
	type ProviderSignInFailed,
	type SubscriptionSignIn,
	signInFor,
} from "./sign-in/sign-in.ts";

/**
 * Connecting a workspace to model providers: checking an address against the
 * egress policy before it is stored, learning what a provider offers, and
 * trying it before it is switched on. Configuring them takes the current
 * actor's `workspace.providers.manage`; seeing which models are offered takes
 * only `workspace.read`.
 *
 * The first model a workspace offers becomes its default and every system
 * agent's. After that, a change that would stop it offering a model one of
 * them runs on fails with `ModelInUse`, so a workspace never goes from some
 * models back to none. A new key or sign-in is not refused: the provider is
 * off only until it has been tried, which happens in the same request.
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
		| AuthorizationDenied
		| ModelProviderNotFound
		| UrlNotAllowed
		| ProviderActivationRequiresCredential
		| ModelInUse,
		CurrentActor.Service
	>;
	readonly remove: (
		input: InProvider,
	) => Effect.Effect<
		void,
		AuthorizationDenied | ModelProviderRemovalNotAllowed | ModelInUse,
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
	/** Asks the provider's sign-in service for a code the person enters to sign it in. */
	readonly startSignIn: (
		input: InProvider,
	) => Effect.Effect<
		ProviderSignInStarted,
		AuthorizationDenied | ModelProviderNotFound | ProviderSignInNotOffered | ProviderSignInFailed,
		CurrentActor.Service
	>;
	/**
	 * Asks whether the person has entered the code of `attempt`, from
	 * `startSignIn`; once they have, the provider is signed in and its
	 * models are discovered.
	 */
	readonly completeSignIn: (
		input: InProvider & { attempt: string },
	) => Effect.Effect<
		ProviderSignInOutcome,
		| AuthorizationDenied
		| ModelProviderNotFound
		| ProviderSignInNotOffered
		| ProviderSignInAttemptInvalid
		| ProviderSignInFailed,
		CurrentActor.Service
	>;
	readonly signOut: (
		input: InProvider,
	) => Effect.Effect<
		ModelProvider,
		AuthorizationDenied | ModelProviderNotFound | ProviderSignInNotOffered | ModelInUse,
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
		| ProviderModelsRequireCredential
		| ProviderModelAlreadyConfigured,
		CurrentActor.Service
	>;
	readonly setModelsEnabled: (
		input: InProvider & { modelIds: string[]; enabled: boolean },
	) => Effect.Effect<
		number,
		AuthorizationDenied | ModelProviderNotFound | ProviderModelsRequireCredential | ModelInUse,
		CurrentActor.Service
	>;
	readonly updateModel: (
		input: InProvider & { modelId: string; changes: ProviderModelUpdate },
	) => Effect.Effect<
		number,
		| AuthorizationDenied
		| ModelProviderNotFound
		| ProviderModelsRequireCredential
		| FetchedModelCapabilitiesImmutable
		| ProviderModelNotFound
		| ModelInUse,
		CurrentActor.Service
	>;
	readonly removeModel: (
		input: InProvider & { modelId: string },
	) => Effect.Effect<
		void,
		AuthorizationDenied | ProviderModelRemovalNotAllowed | ModelInUse,
		CurrentActor.Service
	>;
	/** Makes `model`, which the workspace must offer, the one its new agents start on. */
	readonly setDefaultModel: (
		input: InWorkspace & { model: string },
	) => Effect.Effect<
		WorkspaceModelsResponse,
		AuthorizationDenied | ModelProviderRepository.ModelNotEnabled,
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
	const agents = yield* AgentRepository.Service;
	const egress = yield* Egress.Service;
	const models = yield* Models.Service;
	/** Seals a sign-in in progress; the same key as the stored credentials'. */
	const cipher = yield* Credentials.Service;

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
				(provider) =>
					new ProviderModelsRequireCredential({ missing: missingCredential(provider.preset) }),
			),
		);

	/** The provider's sign-in, and a client that reaches its service. */
	const requireSignIn = (workspaceId: string, providerId: string) =>
		requireProvider(workspaceId, providerId).pipe(
			Effect.map((provider) => signInFor(provider.preset)),
			Effect.filterOrFail(
				(signIn): signIn is SubscriptionSignIn => signIn !== undefined,
				() => new ProviderSignInNotOffered(),
			),
			Effect.map((signIn) => ({
				signIn,
				http: egress.providers.for({ baseUrl: signIn.issuer }),
			})),
		);

	const sealSignInAttempt = (attempt: SignInAttempt) => cipher.encrypt(JSON.stringify(attempt));

	const openSignInAttempt = (sealed: string, workspaceId: string, providerId: string) =>
		Effect.gen(function* () {
			const now = yield* Clock.currentTimeMillis;
			return yield* Effect.try(() => JSON.parse(cipher.decrypt(sealed)) as unknown).pipe(
				Effect.flatMap(Schema.decodeUnknownEffect(SignInAttempt)),
				Effect.mapError(() => new ProviderSignInAttemptInvalid()),
				Effect.filterOrFail(
					(attempt) =>
						attempt.workspaceId === workspaceId &&
						attempt.providerId === providerId &&
						attempt.expiresAt > now,
					() => new ProviderSignInAttemptInvalid(),
				),
			);
		});

	/**
	 * Gives a workspace that has started offering a model its default, and
	 * every system agent without a model that default. Run after anything that
	 * can switch a model or a provider on.
	 */
	const adoptFirstModel = (workspaceId: string) =>
		withHeldModelsLocked(
			workspaceId,
			Effect.gen(function* () {
				const model = yield* providers.ensureDefaultModel(workspaceId);
				if (model !== undefined) {
					yield* agents.fillMissingSystemAgentModels(workspaceId, model);
				}
			}),
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

	const saveSignIn = (workspaceId: string, providerId: string, tokens: OAuthTokens) =>
		Effect.gen(function* () {
			yield* providers.saveOAuthTokens(workspaceId, providerId, tokens);
			yield* discoverModelsQuietly(workspaceId, providerId, true);
			yield* adoptFirstModel(workspaceId);
			return yield* requireProvider(workspaceId, providerId);
		});

	const tryAnEnabledModel = (workspaceId: string, providerId: string, listed: TestOutcome) =>
		Effect.gen(function* () {
			const provider = yield* requireProvider(workspaceId, providerId);
			const enabled = provider.models.find((candidate) => candidate.enabled);
			if (!provider.active || !enabled) return listed;

			const endpoint = yield* providers.endpoint(workspaceId, providerId);
			const started = yield* Clock.currentTimeMillis;
			// Listing a provider's models cannot tell that a model is gated behind
			// a setting on the provider's side, that a key has no credit, or that
			// the model refuses the request shape. Asking it something can.
			const answered = yield* models
				.answer({
					workspaceId,
					model: enabled.modelId,
					system: "Answer with the single word OK.",
					messages: [{ role: "user", content: "OK?" }],
					activity: { purpose: "provider-check" },
					maxCharacters: 200,
					timeout: "30 seconds",
				})
				.pipe(Effect.result);
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
						yield* adoptFirstModel(workspaceId);
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
						return yield* new ProviderActivationRequiresCredential({
							missing: missingCredential(current.preset),
						});
					}
					// Switching on is a test's to do, below, so it is not written here.
					const write = providers.update(workspaceId, providerId, {
						...changes,
						active: changes.active === false ? false : undefined,
					});
					// Switching it off and taking its key away both stop it answering. A
					// new key does only until it is tried, just below.
					const takesAway = changes.active === false || changes.apiKey === null;
					const updated = yield* takesAway ? keepingHeldModelsOffered(workspaceId, write) : write;
					if (!updated) {
						return yield* new ModelProviderNotFound();
					}
					if (changes.apiKey) {
						yield* discoverModelsQuietly(workspaceId, providerId, changes.active !== false);
					} else if (changes.active === true) {
						yield* testProvider(providers, workspaceId, providerId, egress.providers);
					}
					yield* adoptFirstModel(workspaceId);
					return yield* requireProvider(workspaceId, providerId);
				}),
			),

		remove: ({ workspace, providerId }) =>
			operation(
				"remove",
				Effect.gen(function* () {
					const workspaceId = yield* managed(workspace);
					const removed = yield* keepingHeldModelsOffered(
						workspaceId,
						providers.remove(workspaceId, providerId),
					);
					if (!removed) {
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

		startSignIn: ({ workspace, providerId }) =>
			operation(
				"startSignIn",
				Effect.gen(function* () {
					const workspaceId = yield* managed(workspace);
					const { signIn, http } = yield* requireSignIn(workspaceId, providerId);
					const code = yield* signIn.requestDeviceCode(http);
					return {
						verificationUrl: code.verificationUrl,
						userCode: code.userCode,
						attempt: sealSignInAttempt({
							workspaceId,
							providerId,
							deviceCode: code.deviceCode,
							userCode: code.userCode,
							expiresAt: code.expiresAt,
						}),
						pollIntervalMs: code.pollIntervalMs,
						expiresAt: DateTime.formatIso(DateTime.makeUnsafe(code.expiresAt)),
					};
				}),
			),

		completeSignIn: ({ workspace, providerId, attempt: sealed }) =>
			operation(
				"completeSignIn",
				Effect.gen(function* () {
					const workspaceId = yield* managed(workspace);
					const { signIn, http } = yield* requireSignIn(workspaceId, providerId);
					const attempt = yield* openSignInAttempt(sealed, workspaceId, providerId);
					const tokens = yield* signIn.redeemDeviceCode(http, attempt);
					if (!tokens) return { status: "pending" as const };
					return {
						status: "signed_in" as const,
						provider: yield* saveSignIn(workspaceId, providerId, tokens),
					};
				}),
			),

		signOut: ({ workspace, providerId }) =>
			operation(
				"signOut",
				Effect.gen(function* () {
					const workspaceId = yield* managed(workspace);
					yield* requireSignIn(workspaceId, providerId);
					yield* keepingHeldModelsOffered(
						workspaceId,
						providers.saveOAuthTokens(workspaceId, providerId, null),
					);
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
					const updated = yield* keepingHeldModelsOffered(
						workspaceId,
						providers.setModelEnabled(workspaceId, providerId, modelIds, enabled),
					);
					yield* adoptFirstModel(workspaceId);
					return updated;
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
					const updated = yield* keepingHeldModelsOffered(
						workspaceId,
						providers.updateModel(workspaceId, providerId, modelId, changes),
					);
					if (updated === 0) {
						return yield* new ProviderModelNotFound();
					}
					yield* adoptFirstModel(workspaceId);
					return updated;
				}),
			),

		removeModel: ({ workspace, providerId, modelId }) =>
			operation(
				"removeModel",
				Effect.gen(function* () {
					const workspaceId = yield* managed(workspace);
					const removed = yield* keepingHeldModelsOffered(
						workspaceId,
						providers.removeModel(workspaceId, providerId, modelId),
					);
					if (!removed) {
						return yield* new ProviderModelRemovalNotAllowed();
					}
				}),
			),

		setDefaultModel: ({ workspace, model }) =>
			operation(
				"setDefaultModel",
				Effect.gen(function* () {
					const workspaceId = yield* managed(workspace);
					yield* holdingModel(workspaceId, model, providers.setDefaultModel(workspaceId, model));
					return yield* offeredModels(workspaceId);
				}),
			),
	});
});

export const layerNoDeps = Layer.effect(Service, make);

export const layer = layerNoDeps.pipe(
	Layer.provide([
		Authorization.layer,
		ModelProviderRepository.layer,
		AgentRepository.layer,
		Models.layer,
	]),
);

/** A device code in progress, sealed and handed to the page so the server keeps no state for it. */
const SignInAttempt = Schema.Struct({
	workspaceId: Schema.String,
	providerId: Schema.String,
	deviceCode: Schema.String,
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

/** What a provider lacks before it can be used: a key, or a sign-in to a subscription. */
type MissingCredential = "api-key" | SignInServiceId;

function missingCredential(preset: ProviderPresetId | null): MissingCredential {
	return presetSignInService(preset) ?? "api-key";
}

export class ProviderModelsRequireCredential
	extends Data.TaggedError("ProviderModelsRequireCredential")<{
		readonly missing: MissingCredential;
	}>
	implements UserFacing
{
	get userMessage() {
		return this.missing === "api-key"
			? UserMessage.of`Add an API key before managing models`
			: UserMessage.of`Sign in with ${signInServiceNames[this.missing]} before managing models`;
	}
}

export class ProviderActivationRequiresCredential
	extends Data.TaggedError("ProviderActivationRequiresCredential")<{
		readonly missing: MissingCredential;
	}>
	implements UserFacing
{
	get userMessage() {
		return this.missing === "api-key"
			? UserMessage.of`Add an API key before activating this provider`
			: UserMessage.of`Sign in with ${signInServiceNames[this.missing]} before activating this provider`;
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

export class ProviderSignInNotOffered
	extends Data.TaggedError("ProviderSignInNotOffered")
	implements UserFacing
{
	get userMessage() {
		return UserMessage.of`This provider takes an API key, not a sign-in`;
	}
}

export class ProviderSignInAttemptInvalid
	extends Data.TaggedError("ProviderSignInAttemptInvalid")
	implements UserFacing
{
	get userMessage() {
		return UserMessage.of`This sign-in has expired; start again`;
	}
}
