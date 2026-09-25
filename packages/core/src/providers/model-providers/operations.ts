import type {
	ChatgptSignInOutcome,
	ChatgptSignInStarted,
	ModelProviderUpdate,
	NewModelProvider,
	ProviderModel,
	ProviderModelUpdate,
} from "@sugabots/contracts";
import { presetSignsIn, providerLacksCredential, providerPreset } from "@sugabots/contracts";
import { Data, Effect, Schema } from "effect";
import type { TurnModel } from "../../conversations/turns/model.ts";
import { probeModel } from "../../conversations/turns/model.ts";
import type { Credentials } from "../../credentials/credentials.ts";
import type { Database } from "../../database/database.ts";
import type { EgressHttpClients, EgressUrlValidator } from "../network/egress.ts";
import {
	CHATGPT_ISSUER,
	type ChatgptSignInFailed,
	type ChatgptTokens,
	redeemDeviceCode,
	requestDeviceCode,
} from "./chatgpt.ts";
import { fetchProviderModels, testProvider } from "./remote.ts";
import type { ModelProviderStore } from "./store.ts";

export class ModelProviderNotFound extends Data.TaggedError("ModelProviderNotFound") {
	override get message() {
		return "No such model provider";
	}
}

export class ModelProviderUrlNotAllowed extends Data.TaggedError("ModelProviderUrlNotAllowed") {
	override get message() {
		return "Provider URL is not allowed by the network policy";
	}
}

export class ProviderModelsRequireApiKey extends Data.TaggedError("ProviderModelsRequireApiKey") {
	override get message() {
		return "Add an API key before managing models";
	}
}

export class ProviderActivationRequiresApiKey extends Data.TaggedError(
	"ProviderActivationRequiresApiKey",
) {
	override get message() {
		return "Add an API key before activating this provider";
	}
}

export class ModelProviderRemovalNotAllowed extends Data.TaggedError(
	"ModelProviderRemovalNotAllowed",
) {
	override get message() {
		return "Only custom providers can be removed";
	}
}

export class ProviderModelAlreadyConfigured extends Data.TaggedError(
	"ProviderModelAlreadyConfigured",
) {
	override get message() {
		return "That model is already configured in this workspace";
	}
}

export class FetchedModelCapabilitiesImmutable extends Data.TaggedError(
	"FetchedModelCapabilitiesImmutable",
) {
	override get message() {
		return "The provider says what this model can do; switch capabilities off instead";
	}
}

export class ProviderModelNotFound extends Data.TaggedError("ProviderModelNotFound") {
	override get message() {
		return "No such provider model";
	}
}

export class ProviderModelRemovalNotAllowed extends Data.TaggedError(
	"ProviderModelRemovalNotAllowed",
) {
	override get message() {
		return "Only manually added models can be removed";
	}
}

export class ChatgptSignInNotOffered extends Data.TaggedError("ChatgptSignInNotOffered") {
	override get message() {
		return "This provider is not signed in to with ChatGPT";
	}
}

export class ChatgptSignInAttemptInvalid extends Data.TaggedError("ChatgptSignInAttemptInvalid") {
	override get message() {
		return "This sign-in has expired; start again";
	}
}

/** A device code in progress, sealed and handed to the page so the server keeps no state for it. */
const SignInAttempt = Schema.Struct({
	workspaceId: Schema.String,
	providerId: Schema.String,
	deviceAuthId: Schema.String,
	userCode: Schema.String,
	expiresAt: Schema.Number,
});
type SignInAttempt = typeof SignInAttempt.Type;

export interface ProviderTestOutcome {
	reachable: boolean;
	latencyMs: number;
	error?: string;
}

export function modelProviderOperations({
	providers,
	httpClients,
	validateProviderUrl,
	model,
	cipher,
}: {
	providers: ModelProviderStore;
	httpClients: EgressHttpClients;
	validateProviderUrl: EgressUrlValidator;
	model: TurnModel;
	/** Seals a sign-in in progress; the same key as the stored credentials'. */
	cipher: Credentials.Interface;
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

	const openSignInAttempt = (sealed: string, workspaceId: string, providerId: string) =>
		Effect.try(() => JSON.parse(cipher.decrypt(sealed)) as unknown).pipe(
			Effect.flatMap(Schema.decodeUnknownEffect(SignInAttempt)),
			Effect.mapError(() => new ChatgptSignInAttemptInvalid()),
			Effect.filterOrFail(
				(attempt) =>
					attempt.workspaceId === workspaceId &&
					attempt.providerId === providerId &&
					attempt.expiresAt > Date.now(),
				() => new ChatgptSignInAttemptInvalid(),
			),
		);

	const chatgptAuth = httpClients.for({ baseUrl: CHATGPT_ISSUER });
	const seal = (attempt: SignInAttempt) => cipher.encrypt(JSON.stringify(attempt));

	const saveSignIn = (workspaceId: string, providerId: string, tokens: ChatgptTokens) =>
		Effect.gen(function* () {
			yield* providers.saveChatgptSignIn(workspaceId, providerId, tokens);
			yield* discoverModelsQuietly(workspaceId, providerId, true);
			return yield* requireProvider(workspaceId, providerId);
		});

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

			const error = `${enabled.modelId}: ${answered.failure.message}`;
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
				if (input.active && providerLacksCredential(current) && !input.apiKey) {
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

		startChatgptSignIn: (
			workspaceId: string,
			providerId: string,
		): Effect.Effect<
			ChatgptSignInStarted,
			ModelProviderNotFound | ChatgptSignInNotOffered | ChatgptSignInFailed,
			Database
		> =>
			Effect.gen(function* () {
				yield* requireSignInProvider(workspaceId, providerId);
				const code = yield* requestDeviceCode(chatgptAuth);
				return {
					verificationUrl: code.verificationUrl,
					userCode: code.userCode,
					attempt: seal({
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

		completeChatgptSignIn: (
			workspaceId: string,
			providerId: string,
			sealedAttempt: string,
		): Effect.Effect<
			ChatgptSignInOutcome,
			| ModelProviderNotFound
			| ChatgptSignInNotOffered
			| ChatgptSignInAttemptInvalid
			| ChatgptSignInFailed,
			Database
		> =>
			Effect.gen(function* () {
				yield* requireSignInProvider(workspaceId, providerId);
				const attempt = yield* openSignInAttempt(sealedAttempt, workspaceId, providerId);
				const tokens = yield* redeemDeviceCode(chatgptAuth, attempt);
				if (!tokens) return { status: "pending" as const };
				return {
					status: "signed_in" as const,
					provider: yield* saveSignIn(workspaceId, providerId, tokens),
				};
			}),

		signOutChatgpt: (workspaceId: string, providerId: string) =>
			Effect.gen(function* () {
				yield* requireSignInProvider(workspaceId, providerId);
				yield* providers.saveChatgptSignIn(workspaceId, providerId, null);
				return yield* requireProvider(workspaceId, providerId);
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
