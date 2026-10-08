import { type UserText, userText } from "@sugabots/errors";
import { Clock, Data, Effect, Schema } from "effect";
import type { UserFacing } from "../../user-message.ts";
import { type EgressHttpClients, EgressRefused } from "../network/egress.ts";
import {
	type DiscoveredModel,
	dialectFor,
	type ModelRegistry,
	modelsDev,
} from "./dialects/index.ts";
import type { ModelProviderRepository } from "./model-provider-repository.ts";
import { type ProviderSignInFailed, withSignInAccess } from "./sign-in/sign-in.ts";

/**
 * Asking a provider which models it offers and what they can do.
 *
 * The steps are the same for every provider; how each one answers them is
 * its dialect (`dialects/`). Written with Effect so that the ways this can
 * fail are in the types rather than in a `catch` that stringifies whatever
 * arrives.
 */

const MAX_MODEL_RESPONSE_BYTES = 5_000_000;
const MAX_MODELS = 2_000;
/** How many models are asked about at once when a listing needs following up. */
const INSPECT_CONCURRENCY = 4;

/** No credential, so there is nothing to try. */
class ConnectionMissing extends Data.TaggedError("ConnectionMissing")<Record<string, never>> {}
/** We reached the provider and it said no. */
class ProviderRejected extends Data.TaggedError("ProviderRejected")<{
	readonly status: number;
	readonly statusText: string;
}> {}
/** We never got an answer. */
class ProviderUnreachable extends Data.TaggedError("ProviderUnreachable")<{
	readonly cause: unknown;
}> {}
/** The subscription sign-in could not give a live token. */
class SignInLapsed extends Data.TaggedError("SignInLapsed")<{
	readonly failure: ProviderSignInFailed;
}> {}
/** It answered with something that is not a model list. */
class InvalidModelList extends Data.TaggedError("InvalidModelList")<{
	readonly reason: UserText;
}> {}

/** Asking the provider which models it offers failed; `message` is what went wrong, for the logs. */
export class ModelDiscoveryFailed
	extends Data.TaggedError("ModelDiscoveryFailed")<{
		readonly message: string;
		readonly userMessage: UserText;
	}>
	implements UserFacing {}

type ProviderFailure =
	| ConnectionMissing
	| ProviderRejected
	| ProviderUnreachable
	| SignInLapsed
	| InvalidModelList;

/**
 * What a person should be told. Each failure gets its own sentence, in our
 * words: the provider's status text and the network's errors go unquoted.
 */
function describe(failure: ProviderFailure): UserText {
	switch (failure._tag) {
		case "ConnectionMissing":
			return userText`Add an API key before connecting`;
		case "ProviderRejected":
			if (failure.status === 401) {
				return userText`The provider rejected the API key. Replace it with a valid key and try again.`;
			}
			return userText`Provider returned ${failure.status}`;
		case "InvalidModelList":
			return failure.reason;
		case "SignInLapsed":
			return failure.failure.userMessage;
		case "ProviderUnreachable":
			return failure.cause instanceof EgressRefused
				? failure.cause.userMessage
				: userText`Connection failed`;
	}
}

/** What went wrong, for the logs, with whatever the provider or the network said. */
function detail(failure: ProviderFailure): string {
	switch (failure._tag) {
		case "ConnectionMissing":
			return "The provider needs a key it does not have";
		case "ProviderRejected":
			return `The provider answered ${failure.status} ${failure.statusText}`;
		case "InvalidModelList":
			return failure.reason;
		case "SignInLapsed":
			return `The subscription sign-in gave no live token: ${failure.failure.message}`;
		case "ProviderUnreachable":
			return `The provider could not be reached: ${String(failure.cause)}`;
	}
}

const logFailure = (failure: ProviderFailure) =>
	Effect.logWarning("Asking a model provider for its models failed", detail(failure));

export function testProvider(
	providers: Pick<
		ModelProviderRepository.Interface,
		"endpoint" | "recordTest" | "renewOAuthTokens"
	>,
	workspaceId: string,
	providerId: string,
	httpClients: EgressHttpClients,
): Effect.Effect<{ reachable: boolean; latencyMs: number; error?: UserText }> {
	const attempt = Effect.gen(function* () {
		const started = yield* Clock.currentTimeMillis;
		const connection = yield* requireConnection(providers, workspaceId, providerId);

		const outcome = yield* requestModels(providers, workspaceId, connection, httpClients).pipe(
			Effect.tapError(logFailure),
			Effect.result,
		);
		const error = outcome._tag === "Failure" ? describe(outcome.failure) : undefined;

		// A test is recorded either way, and only recorded: switching the provider
		// on or off is the person's to do.
		yield* providers.recordTest(
			workspaceId,
			providerId,
			connection.configurationUpdatedAt,
			error === undefined ? { activateOnSuccess: false } : { error },
		);
		const latencyMs = (yield* Clock.currentTimeMillis) - started;
		return { reachable: error === undefined, latencyMs, error };
	});

	// A missing connection is the one failure with nothing to record against.
	return attempt.pipe(
		Effect.catchTag("ConnectionMissing", (failure) =>
			Effect.succeed({ reachable: false, latencyMs: 0, error: describe(failure) }),
		),
	);
}

export function fetchProviderModels(
	providers: Pick<
		ModelProviderRepository.Interface,
		"endpoint" | "recordTest" | "syncDiscovered" | "renewOAuthTokens"
	>,
	workspaceId: string,
	providerId: string,
	httpClients: EgressHttpClients,
	{
		registry = modelsDev,
		activateOnSuccess = false,
	}: { registry?: ModelRegistry; activateOnSuccess?: boolean } = {},
): Effect.Effect<{ added: number; updated: number; unchanged: number }, ModelDiscoveryFailed> {
	const discover = Effect.gen(function* () {
		const connection = yield* requireConnection(providers, workspaceId, providerId);
		const outcome = yield* requestModels(providers, workspaceId, connection, httpClients).pipe(
			Effect.tapError(logFailure),
			Effect.map((models) => models.map((model) => registry.complete(model, connection))),
			Effect.result,
		);

		if (outcome._tag === "Failure") {
			yield* providers.recordTest(workspaceId, providerId, connection.configurationUpdatedAt, {
				error: describe(outcome.failure),
			});
			return yield* outcome.failure;
		}

		const { added, updated } = yield* providers.syncDiscovered(
			workspaceId,
			providerId,
			outcome.success,
		);
		yield* providers.recordTest(workspaceId, providerId, connection.configurationUpdatedAt, {
			activateOnSuccess,
		});
		return { added, updated, unchanged: outcome.success.length - added - updated };
	});

	// The tags are this module's business. A caller only needs the sentence.
	return discover.pipe(
		Effect.mapError(
			(failure) =>
				new ModelDiscoveryFailed({ message: detail(failure), userMessage: describe(failure) }),
		),
	);
}

function requireConnection(
	providers: Pick<ModelProviderRepository.Interface, "endpoint">,
	workspaceId: string,
	providerId: string,
): Effect.Effect<ModelProviderRepository.ProviderEndpoint, ConnectionMissing> {
	return Effect.filterOrFail(
		providers.endpoint(workspaceId, providerId),
		(connection) => connection != null,
		() => new ConnectionMissing({}),
	);
}

function requestModels(
	providers: Pick<ModelProviderRepository.Interface, "renewOAuthTokens">,
	workspaceId: string,
	stored: ModelProviderRepository.ProviderEndpoint,
	httpClients: EgressHttpClients,
): Effect.Effect<DiscoveredModel[], ProviderFailure> {
	const dialect = dialectFor(stored);
	const baseUrl = stored.baseUrl.replace(/\/$/, "");
	const root = dialect.discoveryRoot?.(baseUrl) ?? baseUrl;
	const http = httpClients.for({ baseUrl: root });
	return Effect.gen(function* () {
		const connection = yield* withSignInAccess(providers, httpClients, workspaceId, stored).pipe(
			Effect.mapError((failure) => new SignInLapsed({ failure })),
		);
		const response = yield* Effect.tryPromise({
			try: () =>
				http(dialect.listingUrl(root), {
					headers: { ...connection.headers, ...dialect.authorization(connection.apiKey) },
					signal: AbortSignal.timeout(15_000),
				}),
			catch: (cause) => new ProviderUnreachable({ cause }),
		});

		if (!response.ok) {
			return yield* new ProviderRejected({
				status: response.status,
				statusText: response.statusText,
			});
		}

		const listing = Schema.decodeUnknownResult(dialect.listing)(yield* readJson(response));
		if (listing._tag === "Failure") {
			return yield* new InvalidModelList({
				reason: userText`Provider returned an invalid model list`,
			});
		}
		if (listing.success.length > MAX_MODELS) {
			return yield* new InvalidModelList({
				reason: userText`Provider returned more than ${MAX_MODELS} models`,
			});
		}
		const listed = distinctById(
			listing.success.flatMap((entry) => {
				const model = Schema.decodeUnknownResult(dialect.model)(entry);
				return model._tag === "Success" ? [model.success] : [];
			}),
		);
		const inspect = dialect.inspect;
		if (!inspect) return listed;
		return yield* Effect.forEach(
			listed,
			(model) => inspect(root, model, http).pipe(Effect.orElseSucceed(() => model)),
			{ concurrency: INSPECT_CONCURRENCY },
		);
	});
}

/** A listing that names a model twice is recorded once; the sync would otherwise refuse the batch. */
function distinctById(models: DiscoveredModel[]): DiscoveredModel[] {
	const seen = new Set<string>();
	return models.filter(({ modelId }) => !seen.has(modelId) && seen.add(modelId));
}

function readJson(response: Response): Effect.Effect<unknown, ProviderFailure> {
	return Effect.gen(function* () {
		if (!response.body) {
			return yield* Effect.tryPromise({
				try: () => response.json(),
				catch: (cause) => new ProviderUnreachable({ cause }),
			});
		}
		const reader = response.body.getReader();
		const decoder = new TextDecoder();
		let bytes = 0;
		let text = "";
		while (true) {
			const chunk = yield* Effect.tryPromise({
				try: () => reader.read(),
				catch: (cause) => new ProviderUnreachable({ cause }),
			});
			if (chunk.done) break;
			bytes += chunk.value.byteLength;
			if (bytes > MAX_MODEL_RESPONSE_BYTES) {
				yield* Effect.promise(() => reader.cancel());
				return yield* new InvalidModelList({
					reason: userText`Provider model response is too large`,
				});
			}
			text += decoder.decode(chunk.value, { stream: true });
		}
		text += decoder.decode();
		return yield* Effect.try({
			try: () => JSON.parse(text) as unknown,
			catch: () =>
				new InvalidModelList({ reason: userText`Provider returned an invalid model list` }),
		});
	});
}
