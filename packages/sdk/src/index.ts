import type { AppType } from "@sugabots/server";
import { hc } from "hono/client";
import { type AuthApi, createAuthApi } from "./auth.ts";
import { createEventsApi, type EventsApi } from "./events.ts";
import { defaultTokenStore, type TokenStore } from "./tokens.ts";

/**
 * The typed API client. Web, Electron and React Native all reach the API
 * through this and nothing else.
 *
 * `AppType` is a development-only type dependency. `verbatimModuleSyntax`
 * erases the import, so no server module, database driver, secret, or Node
 * built-in is bundled into a client. What crosses the boundary is the shape of
 * the routes: add a route to the Hono chain in `packages/server/src/http/app.ts`
 * and it appears here without a second route declaration to keep in step.
 */

export type { AuthApi } from "./auth.ts";
export { isEmailUnverified } from "./auth.ts";
export { ApiError, unwrap, unwrapEmpty } from "./errors.ts";
export type { EventStream, EventStreamOptions, EventsApi } from "./events.ts";
export {
	defaultTokenStore,
	localStorageTokenStore,
	memoryTokenStore,
	type TokenStore,
} from "./tokens.ts";

export type Api = ReturnType<typeof hc<AppType>>;

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
	/** Accounts, sessions, workspaces and invitations. */
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

	const api = hc<AppType>(root, {
		fetch,
		init: { credentials: bearerTokens ? "omit" : "include" },
		headers: (): Record<string, string> => {
			const token = bearerTokens?.get();
			return token ? { authorization: `Bearer ${token}` } : {};
		},
	});

	return {
		baseUrl: root,
		authMode,
		api,
		auth: createAuthApi({ baseUrl: root, tokens: bearerTokens, fetch, origin }),
		events: createEventsApi({ baseUrl: root, tokens: bearerTokens, fetch }),
		tokens: bearerTokens,
	};
}
