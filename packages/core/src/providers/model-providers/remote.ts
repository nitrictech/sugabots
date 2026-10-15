import { type DomainError, type UserText, userText } from "@sugabots/errors";
import { Clock, Effect, ErrorReporter, Schema } from "effect";
import { type EgressHttpClients, EgressRefused } from "../network/egress.ts";
import {
	type DiscoveredModel,
	dialectFor,
	type ModelRegistry,
	modelsDev,
} from "./dialects/index.ts";
import type { ModelProviderRepository } from "./model-provider-repository.ts";
import { ProviderSignInFailed, withSignInAccess } from "./sign-in/sign-in.ts";

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

/** The provider has no API key or sign-in yet. */
export class DiscoveryCredentialsMissing
	extends Schema.TaggedError<DiscoveryCredentialsMissing>()("DiscoveryCredentialsMissing", {})
	implements DomainError
{
	readonly isRetryable = false;
	override readonly [ErrorReporter.severity] = "Info" as const;
	override get message() {
		return "The provider has no API key or sign-in";
	}
	get userMessage() {
		return userText`This provider has no API key or sign-in yet. Add one, then try again.`;
	}
}

/** The provider answered 401 or 403: it doesn't accept the key or sign-in. */
export class DiscoveryCredentialsRejected
	extends Schema.TaggedError<DiscoveryCredentialsRejected>()("DiscoveryCredentialsRejected", {
		status: Schema.Finite,
		statusText: Schema.String,
	})
	implements DomainError
{
	readonly isRetryable = false;
	override readonly [ErrorReporter.severity] = "Warn" as const;
	override get message() {
		return `The provider answered ${this.status} ${this.statusText}`;
	}
	get userMessage() {
		return userText`The provider didn't accept the API key or sign-in. Replace the key, or sign in again, then try again.`;
	}
}

/** The subscription sign-in couldn't give a live token. */
export class DiscoverySignInLapsed
	extends Schema.TaggedError<DiscoverySignInLapsed>()("DiscoverySignInLapsed", {
		cause: Schema.instanceOf(ProviderSignInFailed),
	})
	implements DomainError
{
	readonly isRetryable = false;
	override readonly [ErrorReporter.severity] = "Warn" as const;
	override get message() {
		return `The subscription sign-in gave no live token: ${this.cause.message}`;
	}
	get userMessage() {
		return this.cause.userMessage;
	}
}

/** The provider failed or was busy: a 408, 429 or 5xx. Asking again later may work. */
export class DiscoveryUnavailable
	extends Schema.TaggedError<DiscoveryUnavailable>()("DiscoveryUnavailable", {
		status: Schema.Finite,
		statusText: Schema.String,
	})
	implements DomainError
{
	readonly isRetryable = true;
	override readonly [ErrorReporter.severity] = "Warn" as const;
	override get message() {
		return `The provider answered ${this.status} ${this.statusText}`;
	}
	get userMessage() {
		return userText`The provider couldn't list its models just now. Try again in a few minutes.`;
	}
}

/** No connection to the provider: refused, no such host, or no answer in time. */
export class DiscoveryUnreachable
	extends Schema.TaggedError<DiscoveryUnreachable>()("DiscoveryUnreachable", {
		cause: Schema.Defect(),
	})
	implements DomainError
{
	readonly isRetryable = true;
	override readonly [ErrorReporter.severity] = "Warn" as const;
	override get message() {
		return `The provider could not be reached: ${String(this.cause)}`;
	}
	get userMessage() {
		return userText`We can't reach the provider. Check its address, and that the server is running if it's your own. Then try again.`;
	}
}

/** The network policy refused the provider's address before anything was sent. */
export class DiscoveryAddressRefused
	extends Schema.TaggedError<DiscoveryAddressRefused>()("DiscoveryAddressRefused", {
		cause: Schema.instanceOf(EgressRefused),
	})
	implements DomainError
{
	readonly isRetryable = false;
	override readonly [ErrorReporter.severity] = "Warn" as const;
	override get message() {
		return `The network policy refused the provider's address: ${this.cause.reason}`;
	}
	get userMessage() {
		return userText`We can't send requests to the provider's address. ${this.cause.userMessage}`;
	}
}

/**
 * The provider's answer isn't a model list we can read: a 4xx other than 401
 * or 403 (usually a wrong address), or a body that isn't a model list.
 */
export class ModelListUnreadable
	extends Schema.TaggedError<ModelListUnreadable>()("ModelListUnreadable", {
		/** What was wrong with the answer, for the logs. */
		problem: Schema.String,
		/** The HTTP status, when the provider answered with an error. */
		status: Schema.optional(Schema.Finite),
	})
	implements DomainError
{
	readonly isRetryable = false;
	override readonly [ErrorReporter.severity] = "Warn" as const;
	override get message() {
		return this.problem;
	}
	get userMessage() {
		return userText`The provider didn't send a model list we can read. Check the address is for the provider's API, then try again.`;
	}
}

/** The provider's model list is bigger than we accept: too many bytes or too many models. */
export class ModelListTooLarge
	extends Schema.TaggedError<ModelListTooLarge>()("ModelListTooLarge", {
		/** Which limit it went over, for the logs. */
		problem: Schema.String,
	})
	implements DomainError
{
	readonly isRetryable = false;
	override readonly [ErrorReporter.severity] = "Warn" as const;
	override get message() {
		return this.problem;
	}
	get userMessage() {
		return userText`The provider lists more models than we can take. Add the models you want by hand instead.`;
	}
}

/** Why asking a provider for its models failed. */
export const DiscoveryFailure = Schema.Union([
	DiscoveryCredentialsMissing,
	DiscoveryCredentialsRejected,
	DiscoverySignInLapsed,
	DiscoveryUnavailable,
	DiscoveryUnreachable,
	DiscoveryAddressRefused,
	ModelListUnreadable,
	ModelListTooLarge,
]);
export type DiscoveryFailure = typeof DiscoveryFailure.Type;

/** Whether `failure` is a model discovery failure. */
export const isDiscoveryFailure = Schema.is(DiscoveryFailure);

const logFailure = (failure: DiscoveryFailure) =>
	Effect.logWarning("Asking a model provider for its models failed", failure.message);

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
		const error = outcome._tag === "Failure" ? outcome.failure.userMessage : undefined;

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
		Effect.catchTag("DiscoveryCredentialsMissing", (failure) =>
			Effect.succeed({ reachable: false, latencyMs: 0, error: failure.userMessage }),
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
): Effect.Effect<{ added: number; updated: number; unchanged: number }, DiscoveryFailure> {
	return Effect.gen(function* () {
		const connection = yield* requireConnection(providers, workspaceId, providerId);
		const outcome = yield* requestModels(providers, workspaceId, connection, httpClients).pipe(
			Effect.tapError(logFailure),
			Effect.map((models) => models.map((model) => registry.complete(model, connection))),
			Effect.result,
		);

		if (outcome._tag === "Failure") {
			yield* providers.recordTest(workspaceId, providerId, connection.configurationUpdatedAt, {
				error: outcome.failure.userMessage,
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
}

function requireConnection(
	providers: Pick<ModelProviderRepository.Interface, "endpoint">,
	workspaceId: string,
	providerId: string,
): Effect.Effect<ModelProviderRepository.ProviderEndpoint, DiscoveryCredentialsMissing> {
	return Effect.filterOrFail(
		providers.endpoint(workspaceId, providerId),
		(connection) => connection != null,
		() => new DiscoveryCredentialsMissing(),
	);
}

function requestModels(
	providers: Pick<ModelProviderRepository.Interface, "renewOAuthTokens">,
	workspaceId: string,
	stored: ModelProviderRepository.ProviderEndpoint,
	httpClients: EgressHttpClients,
): Effect.Effect<DiscoveredModel[], DiscoveryFailure> {
	const dialect = dialectFor(stored);
	const baseUrl = stored.baseUrl.replace(/\/$/, "");
	const root = dialect.discoveryRoot?.(baseUrl) ?? baseUrl;
	const http = httpClients.for({ baseUrl: root });
	return Effect.gen(function* () {
		const connection = yield* withSignInAccess(providers, httpClients, workspaceId, stored).pipe(
			Effect.mapError((cause) => new DiscoverySignInLapsed({ cause })),
		);
		const response = yield* Effect.tryPromise({
			try: () =>
				http(dialect.listingUrl(root), {
					headers: { ...connection.headers, ...dialect.authorization(connection.apiKey) },
					signal: AbortSignal.timeout(15_000),
				}),
			catch: unreachable,
		});

		if (!response.ok) return yield* refusal(response);

		const listing = Schema.decodeUnknownResult(dialect.listing)(yield* readJson(response));
		if (listing._tag === "Failure") {
			return yield* new ModelListUnreadable({
				problem: "The provider's model list didn't match its dialect",
			});
		}
		if (listing.success.length > MAX_MODELS) {
			return yield* new ModelListTooLarge({
				problem: `The provider listed more than ${MAX_MODELS} models`,
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

/** The failure for a provider that answered with an error status. */
function refusal(response: Response): DiscoveryFailure {
	const { status, statusText } = response;
	if (status === 401 || status === 403) {
		return new DiscoveryCredentialsRejected({ status, statusText });
	}
	if (status === 408 || status === 429 || status >= 500) {
		return new DiscoveryUnavailable({ status, statusText });
	}
	return new ModelListUnreadable({
		problem: `The provider answered ${status} ${statusText}`,
		status,
	});
}

/** The failure for a request, or a read of its answer, that failed before the whole answer arrived. */
function unreachable(cause: unknown): DiscoveryUnreachable | DiscoveryAddressRefused {
	return cause instanceof EgressRefused && cause.reason !== "unresolved"
		? new DiscoveryAddressRefused({ cause })
		: new DiscoveryUnreachable({ cause });
}

function readJson(
	response: Response,
): Effect.Effect<
	unknown,
	DiscoveryUnreachable | DiscoveryAddressRefused | ModelListUnreadable | ModelListTooLarge
> {
	return Effect.gen(function* () {
		if (!response.body) {
			return yield* Effect.tryPromise({
				try: () => response.json(),
				catch: (cause) => (cause instanceof SyntaxError ? notJson() : unreachable(cause)),
			});
		}
		const reader = response.body.getReader();
		const decoder = new TextDecoder();
		let bytes = 0;
		let text = "";
		while (true) {
			const chunk = yield* Effect.tryPromise({
				try: () => reader.read(),
				catch: unreachable,
			});
			if (chunk.done) break;
			bytes += chunk.value.byteLength;
			if (bytes > MAX_MODEL_RESPONSE_BYTES) {
				yield* Effect.tryPromise(() => reader.cancel()).pipe(Effect.ignore);
				return yield* new ModelListTooLarge({
					problem: `The provider's model list is over ${MAX_MODEL_RESPONSE_BYTES} bytes`,
				});
			}
			text += decoder.decode(chunk.value, { stream: true });
		}
		text += decoder.decode();
		return yield* Effect.try({
			try: () => JSON.parse(text) as unknown,
			catch: notJson,
		});
	});
}

const notJson = () => new ModelListUnreadable({ problem: "The provider's model list isn't JSON" });
