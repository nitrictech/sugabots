import { MAX_PROVIDER_MODELS, type ProviderTestResult } from "@sugabots/contracts";
import {
	DiscoveryAddressRefused,
	DiscoveryCredentialsMissing,
	DiscoveryCredentialsRejected,
	DiscoverySignInLapsed,
	DiscoveryUnavailable,
	DiscoveryUnreachable,
	ModelListTooLarge,
	ModelListUnreadable,
} from "@sugabots/contracts/errors/providers";
import { Effect, Schema } from "effect";
import { type EgressHttpClients, EgressRefused } from "../network/egress.ts";
import { timedTest } from "../tested-configuration.ts";
import {
	type DiscoveredModel,
	dialectFor,
	type ModelRegistry,
	modelsDev,
} from "./dialects/index.ts";
import type { ModelProviderStore } from "./model-provider-store.ts";
import { withSignInAccess } from "./sign-in/sign-in.ts";

/**
 * Asking a provider which models it offers and what they can do.
 *
 * The steps are the same for every provider; how each one answers them is
 * its dialect (`dialects/`). Written with Effect so that the ways this can
 * fail are in the types rather than in a `catch` that stringifies whatever
 * arrives.
 */

const MAX_MODEL_RESPONSE_BYTES = 5_000_000;
/** How many models are asked about at once when a listing needs following up. */
const INSPECT_CONCURRENCY = 4;

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
	providers: Pick<ModelProviderStore.Interface, "access" | "recordTest" | "renewOAuthTokens">,
	workspaceId: string,
	providerId: string,
	httpClients: EgressHttpClients,
): Effect.Effect<ProviderTestResult> {
	const attempt = timedTest(
		Effect.gen(function* () {
			const access = yield* requireAccess(providers, workspaceId, providerId);
			const outcome = yield* requestModels(providers, workspaceId, access, httpClients).pipe(
				Effect.tapError(logFailure),
				Effect.result,
			);
			const error = outcome._tag === "Failure" ? outcome.failure.userMessage : undefined;

			// A test is recorded either way, and only recorded: switching the provider
			// on or off is the member's to do.
			yield* providers.recordTest(
				workspaceId,
				providerId,
				access.configurationUpdatedAt,
				error === undefined ? { activateOnSuccess: false } : { error },
			);
			return { error };
		}),
	);

	// Missing provider access is the one failure with nothing to record against.
	return attempt.pipe(
		Effect.catchTag("DiscoveryCredentialsMissing", (failure) =>
			Effect.succeed({ reachable: false, latencyMs: 0, error: failure.userMessage }),
		),
	);
}

export function fetchProviderModels(
	providers: Pick<
		ModelProviderStore.Interface,
		"access" | "recordTest" | "syncDiscovered" | "renewOAuthTokens"
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
		const access = yield* requireAccess(providers, workspaceId, providerId);
		const outcome = yield* requestModels(providers, workspaceId, access, httpClients).pipe(
			Effect.tapError(logFailure),
			Effect.map((models) => models.map((model) => registry.complete(model, access))),
			Effect.result,
		);

		if (outcome._tag === "Failure") {
			yield* providers.recordTest(workspaceId, providerId, access.configurationUpdatedAt, {
				error: outcome.failure.userMessage,
			});
			return yield* outcome.failure;
		}

		const { added, updated } = yield* providers.syncDiscovered(
			workspaceId,
			providerId,
			outcome.success,
		);
		yield* providers.recordTest(workspaceId, providerId, access.configurationUpdatedAt, {
			activateOnSuccess,
		});
		return { added, updated, unchanged: outcome.success.length - added - updated };
	});
}

function requireAccess(
	providers: Pick<ModelProviderStore.Interface, "access">,
	workspaceId: string,
	providerId: string,
): Effect.Effect<ModelProviderStore.ProviderAccess, DiscoveryCredentialsMissing> {
	return Effect.filterOrFail(
		providers.access(workspaceId, providerId),
		(access) => access != null,
		() => new DiscoveryCredentialsMissing(),
	);
}

function requestModels(
	providers: Pick<ModelProviderStore.Interface, "renewOAuthTokens">,
	workspaceId: string,
	stored: ModelProviderStore.ProviderAccess,
	httpClients: EgressHttpClients,
): Effect.Effect<DiscoveredModel[], DiscoveryFailure> {
	const dialect = dialectFor(stored);
	const baseUrl = stored.baseUrl.replace(/\/$/, "");
	const root = dialect.discoveryRoot?.(baseUrl) ?? baseUrl;
	const http = httpClients.for({ baseUrl: root });
	return Effect.gen(function* () {
		const access = yield* withSignInAccess(providers, httpClients, workspaceId, stored).pipe(
			Effect.mapError((cause) => new DiscoverySignInLapsed({ cause })),
		);
		const response = yield* Effect.tryPromise({
			try: () =>
				http(dialect.listingUrl(root), {
					headers: { ...access.headers, ...dialect.authorization(access.apiKey) },
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
		if (listing.success.length > MAX_PROVIDER_MODELS) {
			return yield* new ModelListTooLarge({
				problem: `The provider listed more than ${MAX_PROVIDER_MODELS} models`,
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
		? new DiscoveryAddressRefused({ rule: cause.reason, reason: cause.userMessage })
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
