import { Data, Effect, Schema } from "effect";
import type { Database } from "../../database/database.ts";
import type { EgressHttpClients } from "../network/egress.ts";
import {
	type DiscoveredModel,
	dialectFor,
	type ModelRegistry,
	modelsDev,
} from "./dialects/index.ts";
import type { ModelProviderStore, ProviderConnection } from "./store.ts";

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
/** It answered with something that is not a model list. */
class InvalidModelList extends Data.TaggedError("InvalidModelList")<{
	readonly reason: string;
}> {}

export class ModelDiscoveryFailed extends Data.TaggedError("ModelDiscoveryFailed")<{
	readonly message: string;
}> {}

type ProviderFailure =
	| ConnectionMissing
	| ProviderRejected
	| ProviderUnreachable
	| InvalidModelList;

/** What a person should be told. Each failure gets its own sentence. */
function describe(failure: ProviderFailure): string {
	switch (failure._tag) {
		case "ConnectionMissing":
			return "Add an API key before connecting";
		case "ProviderRejected":
			return `Provider returned ${failure.status} ${failure.statusText}`;
		case "InvalidModelList":
			return failure.reason;
		case "ProviderUnreachable":
			return failure.cause instanceof Error ? failure.cause.message : "Connection failed";
	}
}

export function testProvider(
	store: Pick<ModelProviderStore, "connection" | "recordTest">,
	workspaceId: string,
	providerId: string,
	httpClients: EgressHttpClients,
): Effect.Effect<{ reachable: boolean; latencyMs: number; error?: string }, never, Database> {
	const attempt = Effect.gen(function* () {
		const started = Date.now();
		const connection = yield* requireConnection(store, workspaceId, providerId);

		const outcome = yield* requestModels(connection, httpClients).pipe(Effect.result);
		const error = outcome._tag === "Failure" ? describe(outcome.failure) : undefined;

		// A test is recorded either way: its result is the point.
		yield* store.recordTest(
			workspaceId,
			providerId,
			connection.configurationUpdatedAt,
			error === undefined ? { activateOnSuccess: true } : { error },
		);
		return { reachable: error === undefined, latencyMs: Date.now() - started, error };
	});

	// A missing connection is the one failure with nothing to record against.
	return attempt.pipe(
		Effect.catchTag("ConnectionMissing", (failure) =>
			Effect.succeed({ reachable: false, latencyMs: 0, error: describe(failure) }),
		),
	);
}

export function fetchProviderModels(
	store: Pick<ModelProviderStore, "connection" | "recordTest" | "syncDiscovered">,
	workspaceId: string,
	providerId: string,
	httpClients: EgressHttpClients,
	{
		registry = modelsDev,
		activateOnSuccess = false,
	}: { registry?: ModelRegistry; activateOnSuccess?: boolean } = {},
): Effect.Effect<
	{ added: number; updated: number; unchanged: number },
	ModelDiscoveryFailed,
	Database
> {
	const discover = Effect.gen(function* () {
		const connection = yield* requireConnection(store, workspaceId, providerId);
		const outcome = yield* requestModels(connection, httpClients).pipe(
			Effect.map((models) => models.map((model) => registry.complete(model, connection))),
			Effect.result,
		);

		if (outcome._tag === "Failure") {
			yield* store.recordTest(workspaceId, providerId, connection.configurationUpdatedAt, {
				error: describe(outcome.failure),
			});
			return yield* outcome.failure;
		}

		const { added, updated } = yield* store.syncDiscovered(
			workspaceId,
			providerId,
			outcome.success,
		);
		yield* store.recordTest(workspaceId, providerId, connection.configurationUpdatedAt, {
			activateOnSuccess,
		});
		return { added, updated, unchanged: outcome.success.length - added - updated };
	});

	// The tags are this module's business. A caller only needs the sentence.
	return discover.pipe(
		Effect.mapError((failure) => new ModelDiscoveryFailed({ message: describe(failure) })),
	);
}

function requireConnection(
	store: Pick<ModelProviderStore, "connection">,
	workspaceId: string,
	providerId: string,
): Effect.Effect<ProviderConnection, ConnectionMissing, Database> {
	return Effect.filterOrFail(
		store.connection(workspaceId, providerId),
		(connection) => connection != null,
		() => new ConnectionMissing({}),
	);
}

function requestModels(
	connection: ProviderConnection,
	httpClients: EgressHttpClients,
): Effect.Effect<DiscoveredModel[], ProviderFailure> {
	const dialect = dialectFor(connection);
	const baseUrl = connection.baseUrl.replace(/\/$/, "");
	const root = dialect.discoveryRoot?.(baseUrl) ?? baseUrl;
	const http = httpClients.for({ baseUrl: root });
	return Effect.gen(function* () {
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
			return yield* new InvalidModelList({ reason: "Provider returned an invalid model list" });
		}
		if (listing.success.length > MAX_MODELS) {
			return yield* new InvalidModelList({
				reason: `Provider returned more than ${MAX_MODELS} models`,
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
				return yield* new InvalidModelList({ reason: "Provider model response is too large" });
			}
			text += decoder.decode(chunk.value, { stream: true });
		}
		text += decoder.decode();
		return yield* Effect.try({
			try: () => JSON.parse(text) as unknown,
			catch: () => new InvalidModelList({ reason: "Provider returned an invalid model list" }),
		});
	});
}
