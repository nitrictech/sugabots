import { Api as ApiDefinition } from "@sugabots/contracts/http";
import { Effect, Layer } from "effect";
import { FetchHttpClient, HttpClient, HttpClientRequest } from "effect/unstable/http";
import { HttpApiClient } from "effect/unstable/httpapi";
import { type AuthApi, createAuthApi } from "./auth.ts";
import { createEventsApi, type EventsApi } from "./events.ts";
import { defaultTokenStore, type TokenStore } from "./tokens.ts";

/**
 * The typed API client. Web, Electron and React Native all reach the API
 * through this and nothing else.
 *
 * `api` is derived from the API's definition in `@sugabots/contracts/http`,
 * which the server implements, so an endpoint added there appears here with
 * no second declaration to keep in step. Each call is an `Effect` that
 * succeeds with the decoded response, or fails with one of the errors that
 * endpoint declares — or with the transport or decoding failure of a request
 * that never got an answer.
 */

export type { AuthApi } from "./auth.ts";
export { isEmailUnverified, isResetLinkInvalid } from "./auth.ts";
export { failureForStatus, isApiFailure } from "./errors.ts";
export type { EventStream, EventStreamOptions, EventsApi } from "./events.ts";
export {
	defaultTokenStore,
	localStorageTokenStore,
	memoryTokenStore,
	type TokenStore,
} from "./tokens.ts";

export type Api = HttpApiClient.ForApi<typeof ApiDefinition>;

interface ClientBaseOptions {
	/** Where the API is, path included, e.g. `https://example.com/api`. */
	baseUrl: string;
	/** Overridable for tests, and for runtimes with their own fetch. */
	fetch?: typeof globalThis.fetch;
	/**
	 * The origin to declare to the auth routes. Ignored in the browser, which
	 * sets its own. Defaults to the API's origin.
	 */
	origin?: string;
}

export type ClientOptions = ClientBaseOptions &
	(
		| {
				/** Bearer is the default for compatibility with native and script clients. */
				authMode?: "bearer";
				/** Defaults to an in-memory store. Requests read it synchronously. */
				tokens?: TokenStore;
		  }
		| {
				/** Uses HttpOnly cookies and rejects a bearer token store. */
				authMode: "cookie";
				tokens?: never;
		  }
	);

export interface Client {
	readonly baseUrl: string;
	readonly authMode: "bearer" | "cookie";
	/** The routes, typed from the API. */
	readonly api: Api;
	/** Signing up, in and out. Workspaces and invitations are routes in `api`. */
	readonly auth: AuthApi;
	/** Live updates: one stream per open thread, one per workspace. */
	readonly events: EventsApi;
	/** The bearer store, absent when `authMode` is `cookie`. */
	readonly tokens: TokenStore | undefined;
}

export function createClient(options: ClientOptions): Client {
	const { baseUrl, fetch, origin } = options;
	const authMode = options.authMode ?? "bearer";
	if (authMode !== "bearer" && authMode !== "cookie") {
		throw new TypeError(`Unsupported authentication mode: ${String(authMode)}`);
	}
	if (authMode === "cookie" && options.tokens !== undefined) {
		throw new TypeError("Cookie authentication cannot use a bearer token store");
	}

	const root = baseUrl.replace(/\/+$/, "");
	const bearerTokens = authMode === "bearer" ? (options.tokens ?? defaultTokenStore()) : undefined;

	return {
		baseUrl: root,
		authMode,
		api: createApi({ baseUrl: root, fetch, tokens: bearerTokens }),
		auth: createAuthApi({ baseUrl: root, tokens: bearerTokens, fetch, origin }),
		events: createEventsApi({ baseUrl: root, tokens: bearerTokens, fetch }),
		tokens: bearerTokens,
	};
}

function createApi({
	baseUrl,
	fetch,
	tokens,
}: {
	baseUrl: string;
	fetch: typeof globalThis.fetch | undefined;
	tokens: TokenStore | undefined;
}): Api {
	const fetchClient = FetchHttpClient.layer.pipe(
		Layer.provide(
			Layer.mergeAll(
				Layer.succeed(FetchHttpClient.RequestInit, { credentials: tokens ? "omit" : "include" }),
				fetch ? Layer.succeed(FetchHttpClient.Fetch, fetch) : Layer.empty,
			),
		),
	);
	const httpClient = Effect.runSync(
		Effect.provide(Effect.service(HttpClient.HttpClient), fetchClient),
	).pipe(
		// Read at each request, so a sign-in or sign-out takes effect on the next call.
		HttpClient.mapRequest((request) => {
			const token = tokens?.get();
			return token ? HttpClientRequest.bearerToken(request, token) : request;
		}),
		// The client's spans are never exported, so a `traceparent` naming one
		// would leave every server trace pointing at a parent that never arrives.
		HttpClient.transform((response) =>
			Effect.provideService(response, HttpClient.TracerPropagationEnabled, false),
		),
	);
	return Effect.runSync(HttpApiClient.makeWith(ApiDefinition, { httpClient, baseUrl }));
}
