export * as ModelProviders from "./model-providers.ts";

import type {
	BotMove,
	BuiltInProviderId,
	ModelProvider,
	ModelProviderUpdate,
	NewModelProvider,
	ProviderModel,
	ProviderModelUpdate,
	ProviderSignInOutcome,
	ProviderSignInStarted,
	ProviderTestResult,
	WorkspaceModelsResponse,
} from "@sugabots/contracts";
import {
	builtInSignInService,
	providerBuiltIn,
	providerLacksCredential,
} from "@sugabots/contracts";
import { type ActionForbidden, ResourceHidden } from "@sugabots/contracts/errors/proofs";
import {
	FetchedModelCapabilitiesImmutable,
	type MissingCredential,
	type ModelInUse,
	type ModelNotEnabled,
	type ModelProviderNameConflict,
	ModelProviderNotFound,
	ModelProviderRemovalNotAllowed,
	ProviderActivationRequiresCredential,
	ProviderModelAlreadyConfigured,
	ProviderModelNotFound,
	ProviderModelsRequireCredential,
	ProviderSignInAttemptInvalid,
	type ProviderSignInFailed,
	ProviderSignInNotOffered,
	type UrlNotAllowed,
} from "@sugabots/contracts/errors/providers";
import { uuidSchema } from "@sugabots/contracts/uuid";
import { Clock, Context, DateTime, Effect, Layer, Schema } from "effect";
import { serviceOperations } from "../../database/database.ts";
import { proveIsMember } from "../../proofs/is-member.ts";
import type { CanManageWorkspace, CanReadWorkspace } from "../../proofs/workspace-permissions.ts";
import { Secrets } from "../../secrets/secrets.ts";
import { processLayer, Tier } from "../../tiers.ts";
import { BotStore } from "../../workspaces/bots/bot-store.ts";
import { Egress } from "../network/egress.ts";
import { changesAddress, requireAllowedUrl } from "../tested-configuration.ts";
import { holdingModel, keepingHeldModelsOffered, withHeldModelsLocked } from "./held-models.ts";
import { offeredModels, providerIn, providersIn } from "./model-provider-reads.ts";
import { ModelProviderStore } from "./model-provider-store.ts";
import {
	type DiscoveryFailure,
	fetchProviderModels,
	isDiscoveryFailure,
	testProvider,
} from "./remote.ts";
import { type OAuthTokens, type SubscriptionSignIn, signInFor } from "./sign-in/sign-in.ts";

/**
 * A workspace's model providers, for operations that have proved what each
 * call needs: checking an address against the egress policy before it is
 * stored, learning what a provider offers, and trying it before it is
 * switched on. Each method takes the workspace from its proof, and records
 * the member whose role gave it as whoever adds, connects or signs in a
 * provider. Configuring providers takes `CanManageWorkspace`; seeing which
 * models are offered takes only `CanReadWorkspace`.
 *
 * The first model a workspace offers becomes its default and every system
 * bot's. After that, a change that would stop it offering a model one of
 * them runs on fails with `ModelInUse`, so a workspace never goes from some
 * models back to none. A new key or sign-in is not refused: the provider is
 * off only until it has been tried, which happens in the same call.
 */
export interface Interface {
	/** The workspace's providers, with their models, as its settings list them. */
	readonly list: <P, W>(canManage: CanManageWorkspace<P, W>) => Effect.Effect<ModelProvider[]>;
	/** The models the workspace offers bots, and the one its new bots start on. */
	readonly listEnabledModels: <P, W>(
		canRead: CanReadWorkspace<P, W>,
	) => Effect.Effect<WorkspaceModelsResponse>;
	/** Discovers the new provider's models straight away when it has a key. */
	readonly create: <P, W>(
		canManage: CanManageWorkspace<P, W>,
		provider: NewModelProvider,
	) => Effect.Effect<
		ModelProvider,
		UrlNotAllowed | ModelProviderNameConflict | ModelProviderNotFound
	>;
	/**
	 * A new key sends the provider back through discovery, and switching it on
	 * tests it first; either way it is on only once it has answered. A new
	 * address does the same, and without a new key also takes away the key,
	 * headers and sign-in it held. A new key takes the place of a subscription
	 * sign-in. Switching it off, removing its key or moving it fails with
	 * `ModelInUse` rather than stop offering a model the workspace depends on.
	 */
	readonly update: <P, W>(
		canManage: CanManageWorkspace<P, W>,
		providerId: string,
		changes: ModelProviderUpdate,
	) => Effect.Effect<
		ModelProvider,
		ModelProviderNotFound | UrlNotAllowed | ProviderActivationRequiresCredential | ModelInUse
	>;
	readonly remove: <P, W>(
		canManage: CanManageWorkspace<P, W>,
		providerId: string,
	) => Effect.Effect<void, ModelProviderRemovalNotAllowed | ModelInUse>;
	/** Lists the provider's models, which costs nothing, and records whether that worked. */
	readonly test: <P, W>(
		canManage: CanManageWorkspace<P, W>,
		providerId: string,
	) => Effect.Effect<ProviderTestResult, ModelProviderNotFound>;
	/** Asks the provider's sign-in service for a code the member enters to sign it in. */
	readonly startSignIn: <P, W>(
		canManage: CanManageWorkspace<P, W>,
		providerId: string,
	) => Effect.Effect<
		ProviderSignInStarted,
		ActionForbidden | ModelProviderNotFound | ProviderSignInNotOffered | ProviderSignInFailed
	>;
	/**
	 * Asks whether the member has entered the code of `attempt`, from
	 * `startSignIn`; once they have, the provider is signed in as the member
	 * whose role gave `canManage`, and its models are discovered. Hidden once
	 * they are no longer in the workspace.
	 */
	readonly completeSignIn: <P, W>(
		canManage: CanManageWorkspace<P, W>,
		providerId: string,
		attempt: string | undefined,
	) => Effect.Effect<
		ProviderSignInOutcome,
		| ModelProviderNotFound
		| ProviderSignInNotOffered
		| ProviderSignInAttemptInvalid
		| ProviderSignInFailed
		| ResourceHidden
	>;
	readonly signOut: <P, W>(
		canManage: CanManageWorkspace<P, W>,
		providerId: string,
	) => Effect.Effect<ModelProvider, ModelProviderNotFound | ProviderSignInNotOffered | ModelInUse>;
	readonly discoverModels: <P, W>(
		canManage: CanManageWorkspace<P, W>,
		providerId: string,
	) => Effect.Effect<void, DiscoveryFailure>;
	readonly addModel: <P, W>(
		canManage: CanManageWorkspace<P, W>,
		providerId: string,
		model: Pick<ProviderModel, "modelId" | "capabilities"> &
			Partial<Pick<ProviderModel, "displayName" | "contextLength">>,
	) => Effect.Effect<
		ModelProvider,
		ModelProviderNotFound | ProviderModelsRequireCredential | ProviderModelAlreadyConfigured
	>;
	readonly updateModel: <P, W>(
		canManage: CanManageWorkspace<P, W>,
		providerId: string,
		modelId: string,
		changes: ProviderModelUpdate,
	) => Effect.Effect<
		void,
		| ModelProviderNotFound
		| ProviderModelsRequireCredential
		| FetchedModelCapabilitiesImmutable
		| ProviderModelNotFound
		| ModelInUse
	>;
	/**
	 * Switches a model off and moves the bots on it to `moveBotsTo`, and the
	 * default and the system bots to `newBotsTo` and `systemBotsTo`, as
	 * {@link SettingMoves} says.
	 */
	readonly switchOffModel: <P, W>(
		canManage: CanManageWorkspace<P, W>,
		providerId: string,
		modelId: string,
		moves: { moveBotsTo?: string } & SettingMoves,
	) => Effect.Effect<
		void,
		| ModelProviderNotFound
		| ProviderModelsRequireCredential
		| ProviderModelNotFound
		| ModelNotEnabled
		| ModelInUse
	>;
	/**
	 * Switches a provider off and moves the bots on each `from` model to its
	 * `to`, as {@link Interface.switchOffModel} does for one model.
	 */
	readonly switchOff: <P, W>(
		canManage: CanManageWorkspace<P, W>,
		providerId: string,
		moves: { moveBots: readonly BotMove[] } & SettingMoves,
	) => Effect.Effect<void, ModelProviderNotFound | ModelNotEnabled | ModelInUse>;
	/** Makes `model`, which the workspace must offer, the one its new bots start on. */
	readonly setDefaultModel: <P, W>(
		canManage: CanManageWorkspace<P, W>,
		model: string,
	) => Effect.Effect<WorkspaceModelsResponse, ModelNotEnabled>;
}

/**
 * Where the workspace's default and its system bots move as a switch-off
 * stops offering the model they run on. Every model moved to must still be
 * offered afterwards. One left out stays put, and the switch-off fails with
 * `ModelInUse` if that leaves it on a model no longer offered.
 */
interface SettingMoves {
	newBotsTo?: string;
	systemBotsTo?: string;
}

export class Service extends Context.Service<Service, Interface>()(
	"@sugabots/core/ModelProviders",
) {
	declare readonly [Tier]: "process";
}

export const make = Effect.gen(function* () {
	const operation = yield* serviceOperations<Interface>("ModelProviders");
	const providers = yield* ModelProviderStore.Service;
	const bots = yield* BotStore.Service;
	const egress = yield* Egress.Service;
	/** Seals a sign-in in progress; the same key as the stored credentials'. */
	const cipher = yield* Secrets.Service;

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
					new ProviderModelsRequireCredential({ missing: missingCredential(provider.builtIn) }),
			),
		);

	/**
	 * Runs `switchOff`, then moves the bots on each `from` the workspace
	 * no longer offers to its `to`, which it must. A `from` the workspace still
	 * offers was named in error, and keeps its bots. The default and the system
	 * bots move as {@link SettingMoves} says.
	 */
	const movingOffSwitchedOff = <E, R>(
		workspaceId: string,
		{ moves, newBotsTo, systemBotsTo }: { moves: readonly BotMove[] } & SettingMoves,
		switchOff: Effect.Effect<unknown, E, R>,
	) =>
		keepingHeldModelsOffered(
			workspaceId,
			Effect.gen(function* () {
				yield* switchOff;
				if (newBotsTo !== undefined) {
					yield* providers.requireEnabled(workspaceId, newBotsTo);
					yield* providers.setDefaultModel(workspaceId, newBotsTo);
				}
				if (systemBotsTo !== undefined) {
					yield* providers.requireEnabled(workspaceId, systemBotsTo);
					yield* bots.setAllSystemBotModels(workspaceId, systemBotsTo);
				}
				yield* Effect.forEach(moves, ({ from, to }) =>
					Effect.gen(function* () {
						if (yield* providers.isEnabled(workspaceId, from)) return;
						yield* providers.requireEnabled(workspaceId, to);
						yield* bots.moveMemberFacingBotsToModel(workspaceId, from, to);
					}),
				);
			}),
		);

	/** The provider's sign-in, and a client that reaches its service. */
	const requireSignIn = (workspaceId: string, providerId: string) =>
		requireProvider(workspaceId, providerId).pipe(
			Effect.map((provider) => signInFor(provider.builtIn)),
			Effect.filterOrFail(
				(signIn): signIn is SubscriptionSignIn => signIn !== undefined,
				() => new ProviderSignInNotOffered(),
			),
			Effect.map((signIn) => ({
				signIn,
				http: egress.providers.for({ baseUrl: signIn.issuer }),
			})),
		);

	const encryptSignInAttempt = (attempt: SignInAttempt) => cipher.encrypt(JSON.stringify(attempt));

	const openSignInAttempt = (
		sealed: string | undefined,
		forSession: Pick<SignInAttempt, "workspaceId" | "providerId" | "memberId" | "sessionId">,
	) =>
		Effect.gen(function* () {
			if (!sealed) return yield* new ProviderSignInAttemptInvalid();
			const now = yield* Clock.currentTimeMillis;
			return yield* Effect.try(() => JSON.parse(cipher.decrypt(sealed)) as unknown).pipe(
				Effect.flatMap(Schema.decodeUnknownEffect(SignInAttempt)),
				Effect.mapError(() => new ProviderSignInAttemptInvalid()),
				Effect.filterOrFail(
					(attempt) =>
						attempt.workspaceId === forSession.workspaceId &&
						attempt.providerId === forSession.providerId &&
						attempt.memberId === forSession.memberId &&
						attempt.sessionId === forSession.sessionId &&
						attempt.expiresAt > now,
					() => new ProviderSignInAttemptInvalid(),
				),
			);
		});

	/**
	 * Gives a workspace that has started offering a model its default, and
	 * every system bot and Personal Assistant without a model that default.
	 * Run after anything that can switch a model or a provider on.
	 */
	const adoptFirstModel = (workspaceId: string) =>
		withHeldModelsLocked(
			workspaceId,
			Effect.gen(function* () {
				const model = yield* providers.ensureDefaultModel(workspaceId);
				if (model !== undefined) {
					yield* bots.fillMissingSystemBotModels(workspaceId, model);
					yield* bots.fillMissingAssistantModels(workspaceId, model);
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
		}).pipe(Effect.catchIf(isDiscoveryFailure, () => Effect.void));

	const saveSignIn = (
		workspaceId: string,
		providerId: string,
		tokens: OAuthTokens,
		signedInById: string,
	) =>
		Effect.gen(function* () {
			const saved = yield* providers.saveOAuthTokens(workspaceId, providerId, {
				tokens,
				signedInById,
			});
			// They left the workspace, or were removed from it, while signing in.
			if (!saved) return yield* new ResourceHidden({ resource: "workspace" });
			yield* discoverModelsQuietly(workspaceId, providerId, true);
			yield* adoptFirstModel(workspaceId);
			return yield* requireProvider(workspaceId, providerId);
		});

	return Service.of({
		list: (canManage) => operation("list", providersIn(canManage.inWorkspace.workspace.value)),

		listEnabledModels: (canRead) =>
			operation("listEnabledModels", offeredModels(canRead.inWorkspace.workspace.value)),

		create: (canManage, provider) =>
			operation(
				"create",
				Effect.gen(function* () {
					const workspaceId = canManage.inWorkspace.workspace.value;
					yield* requireAllowedUrl(
						egress,
						provider.baseUrl ??
							("builtIn" in provider ? providerBuiltIn(provider.builtIn).baseUrl : ""),
					);
					const created = yield* providers.create(workspaceId, {
						createdById: canManage.actor.memberId,
						provider,
					});
					if (created.apiKeyEncrypted !== null) {
						yield* discoverModelsQuietly(workspaceId, created.id, true);
						yield* adoptFirstModel(workspaceId);
					}
					return yield* requireProvider(workspaceId, created.id);
				}),
			),

		update: (canManage, providerId, changes) =>
			operation(
				"update",
				Effect.gen(function* () {
					const workspaceId = canManage.inWorkspace.workspace.value;
					const current = yield* requireProvider(workspaceId, providerId);
					if (changes.baseUrl) {
						yield* requireAllowedUrl(egress, changes.baseUrl);
					}
					const moved = changesAddress(changes.baseUrl, current.baseUrl);
					// A new address takes away the key and sign-in, unless a key comes with it.
					const losesCredential = moved && !changes.apiKey;
					const credentialAfter = losesCredential
						? { ...current, hasApiKey: false, signedIn: false }
						: current;
					if (
						changes.active === true &&
						providerLacksCredential(credentialAfter) &&
						!changes.apiKey
					) {
						return yield* new ProviderActivationRequiresCredential({
							missing: missingCredential(current.builtIn),
						});
					}
					const write = providers.update(
						workspaceId,
						providerId,
						changes,
						canManage.actor.memberId,
					);
					// Switching it off, taking its key away and moving it all stop it
					// answering. A new key or address does only until it is tried, just below.
					const takesAway = changes.active === false || changes.apiKey === null || moved;
					const updated = yield* takesAway ? keepingHeldModelsOffered(workspaceId, write) : write;
					if (!updated) {
						return yield* new ModelProviderNotFound();
					}
					if (changes.apiKey || moved) {
						// A new key comes on unless switched off with it; a new address
						// comes back on only if the provider was on.
						const activateOnSuccess = changes.active ?? (changes.apiKey ? true : current.active);
						yield* discoverModelsQuietly(workspaceId, providerId, activateOnSuccess);
					}
					yield* adoptFirstModel(workspaceId);
					return yield* requireProvider(workspaceId, providerId);
				}),
			),

		remove: (canManage, providerId) =>
			operation(
				"remove",
				Effect.gen(function* () {
					const workspaceId = canManage.inWorkspace.workspace.value;
					const removed = yield* keepingHeldModelsOffered(
						workspaceId,
						providers.remove(workspaceId, providerId),
					);
					if (!removed) {
						return yield* new ModelProviderRemovalNotAllowed();
					}
				}),
			),

		test: (canManage, providerId) =>
			operation(
				"test",
				Effect.gen(function* () {
					const workspaceId = canManage.inWorkspace.workspace.value;
					yield* requireProvider(workspaceId, providerId);
					return yield* testProvider(providers, workspaceId, providerId, egress.providers);
				}),
			),

		startSignIn: (canManage, providerId) =>
			operation(
				"startSignIn",
				Effect.gen(function* () {
					const workspaceId = canManage.inWorkspace.workspace.value;
					const { signIn, http } = yield* requireSignIn(workspaceId, providerId);
					const session = yield* proveIsMember(canManage.inWorkspace.principal);
					const code = yield* signIn.requestDeviceCode(http);
					return {
						verificationUrl: code.verificationUrl,
						userCode: code.userCode,
						attempt: encryptSignInAttempt({
							memberId: session.member,
							sessionId: session.session,
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

		completeSignIn: (canManage, providerId, sealed) =>
			operation(
				"completeSignIn",
				Effect.gen(function* () {
					const workspaceId = canManage.inWorkspace.workspace.value;
					const session = yield* proveIsMember(canManage.inWorkspace.principal).pipe(
						Effect.mapError(() => new ProviderSignInAttemptInvalid()),
					);
					const attempt = yield* openSignInAttempt(sealed, {
						workspaceId,
						providerId,
						memberId: session.member,
						sessionId: session.session,
					});
					const { signIn, http } = yield* requireSignIn(workspaceId, providerId);
					const tokens = yield* signIn.redeemDeviceCode(http, attempt);
					if (!tokens) return { status: "pending" as const };
					return {
						status: "signed_in" as const,
						provider: yield* saveSignIn(workspaceId, providerId, tokens, canManage.actor.memberId),
					};
				}),
			),

		signOut: (canManage, providerId) =>
			operation(
				"signOut",
				Effect.gen(function* () {
					const workspaceId = canManage.inWorkspace.workspace.value;
					yield* requireSignIn(workspaceId, providerId);
					yield* keepingHeldModelsOffered(
						workspaceId,
						providers.saveOAuthTokens(workspaceId, providerId, null),
					);
					return yield* requireProvider(workspaceId, providerId);
				}),
			),

		discoverModels: (canManage, providerId) =>
			operation(
				"discoverModels",
				fetchProviderModels(
					providers,
					canManage.inWorkspace.workspace.value,
					providerId,
					egress.providers,
				).pipe(Effect.asVoid),
			),

		addModel: (canManage, providerId, model) =>
			operation(
				"addModel",
				Effect.gen(function* () {
					const workspaceId = canManage.inWorkspace.workspace.value;
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

		updateModel: (canManage, providerId, modelId, changes) =>
			operation(
				"updateModel",
				Effect.gen(function* () {
					const workspaceId = canManage.inWorkspace.workspace.value;
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
				}),
			),

		switchOffModel: (canManage, providerId, modelId, { moveBotsTo, newBotsTo, systemBotsTo }) =>
			operation(
				"switchOffModel",
				Effect.gen(function* () {
					const workspaceId = canManage.inWorkspace.workspace.value;
					const provider = yield* requireConnectedProvider(workspaceId, providerId);
					const switchingOff = provider.models.find((candidate) => candidate.id === modelId);
					if (!switchingOff) {
						return yield* new ProviderModelNotFound();
					}
					yield* movingOffSwitchedOff(
						workspaceId,
						{
							moves: moveBotsTo ? [{ from: switchingOff.modelId, to: moveBotsTo }] : [],
							newBotsTo,
							systemBotsTo,
						},
						providers.updateModel(workspaceId, providerId, modelId, { enabled: false }),
					);
				}),
			),

		switchOff: (canManage, providerId, { moveBots, newBotsTo, systemBotsTo }) =>
			operation(
				"switchOff",
				Effect.gen(function* () {
					const workspaceId = canManage.inWorkspace.workspace.value;
					yield* movingOffSwitchedOff(
						workspaceId,
						{ moves: moveBots, newBotsTo, systemBotsTo },
						Effect.filterOrFail(
							providers.update(
								workspaceId,
								providerId,
								{ active: false },
								canManage.actor.memberId,
							),
							(updated) => updated !== undefined,
							() => new ModelProviderNotFound(),
						),
					);
				}),
			),

		setDefaultModel: (canManage, model) =>
			operation(
				"setDefaultModel",
				Effect.gen(function* () {
					const workspaceId = canManage.inWorkspace.workspace.value;
					yield* holdingModel(workspaceId, model, providers.setDefaultModel(workspaceId, model));
					return yield* offeredModels(workspaceId);
				}),
			),
	});
});

export const layerNoDeps = processLayer(Layer.effect(Service, make));

export const layer = layerNoDeps.pipe(Layer.provide([ModelProviderStore.layer, BotStore.layer]));

/** A device code in progress, sealed and handed to the page so the server keeps no state for it. */
const SignInAttempt = Schema.Struct({
	memberId: uuidSchema,
	sessionId: Schema.String,
	workspaceId: uuidSchema,
	providerId: uuidSchema,
	deviceCode: Schema.String,
	userCode: Schema.String,
	expiresAt: Schema.Number,
});
type SignInAttempt = typeof SignInAttempt.Type;

function missingCredential(builtIn: BuiltInProviderId | null): MissingCredential {
	return builtInSignInService(builtIn) ?? "api-key";
}
