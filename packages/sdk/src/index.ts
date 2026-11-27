import { Api as ApiDefinition } from "@sugabots/contracts/http";
import { Effect, Layer } from "effect";
import { FetchHttpClient, HttpClient } from "effect/unstable/http";
import { HttpApiClient } from "effect/unstable/httpapi";
import { type AuthApi, createAuthApi } from "./auth.ts";
import { createEventsApi, type EventsApi } from "./events.ts";

/**
 * The typed API client, which the web app reaches the API through. Every
 * request sends the browser's session cookie.
 *
 * `api` is derived from the API's definition in `@sugabots/contracts/http`,
 * which the server implements. An operation offered over HTTP is an endpoint
 * there because its contract says so, named for it: `chats.setResolved` is
 * `api.chats.setResolved({ params, payload })`, its path parameters in
 * `params` and its other input in `query` or `payload`, as the operation
 * takes them. So an operation added there appears here with no second
 * declaration to keep in step. Each call is an `Effect` that
 * succeeds with the decoded response, or fails with one of the errors that
 * endpoint declares — or with the transport or decoding failure of a request
 * that never got an answer.
 */

export type { AuthApi } from "./auth.ts";
export { isEmailUnverified, isResetLinkInvalid } from "./auth.ts";
export { failureForStatus, failureFromResponse, isApiFailure } from "./errors.ts";
export type { EventStream, EventsApi } from "./events.ts";

export type Api = HttpApiClient.ForApi<typeof ApiDefinition>;

interface ClientOptions {
	/** Where the API is, path included, e.g. `https://example.com/api`. */
	baseUrl: string;
	/** Overridable for tests, and for runtimes with their own fetch. */
	fetch?: typeof globalThis.fetch;
}

export interface Client {
	readonly baseUrl: string;
	/** The routes, typed from the API. */
	readonly api: Api;
	/** Signing up, in and out. Workspaces and invitations are routes in `api`. */
	readonly auth: AuthApi;
	/** Live updates: one stream per open chat, one per workspace. */
	readonly events: EventsApi;
}

export function createClient({ baseUrl, fetch }: ClientOptions): Client {
	const root = baseUrl.replace(/\/+$/, "");
	const api = createApi({ baseUrl: root, fetch });
	return {
		baseUrl: root,
		api,
		auth: createAuthApi({ baseUrl: root, fetch, api }),
		events: createEventsApi({ baseUrl: root, fetch }),
	};
}

function createApi({
	baseUrl,
	fetch,
}: {
	baseUrl: string;
	fetch: typeof globalThis.fetch | undefined;
}): Api {
	const fetchClient = FetchHttpClient.layer.pipe(
		Layer.provide(
			Layer.mergeAll(
				Layer.succeed(FetchHttpClient.RequestInit, { credentials: "include" }),
				fetch ? Layer.succeed(FetchHttpClient.Fetch, fetch) : Layer.empty,
			),
		),
	);
	const httpClient = Effect.runSync(
		Effect.provide(Effect.service(HttpClient.HttpClient), fetchClient),
	).pipe(
		// The client's spans are never exported, so a `traceparent` naming one
		// would leave every server trace pointing at a parent that never arrives.
		HttpClient.transform((response) =>
			Effect.provideService(response, HttpClient.TracerPropagationEnabled, false),
		),
	);
	return Effect.runSync(HttpApiClient.makeWith(ApiDefinition, { httpClient, baseUrl }));
}
