import { randomBytes } from "node:crypto";
import {
	auth,
	type OAuthAuthorizationServerInformation,
	type OAuthClientInformation,
	type OAuthClientProvider,
	type OAuthTokens,
	UnauthorizedError,
} from "@ai-sdk/mcp";
import { extractWWWAuthenticateParams } from "@modelcontextprotocol/sdk/client/auth.js";
import { causesOf } from "../causes.ts";
import type { EgressHttpClient } from "../network/egress.ts";

/**
 * Signing a connector in through the server's own OAuth.
 *
 * The AI SDK's client does the protocol: discovers the authorization server,
 * registers this server as a client, sends the browser to sign in with
 * PKCE, exchanges the code, and refreshes tokens as they expire. What it needs
 * from us is somewhere to keep what it learns, which is one sealed record on
 * the connector row, and a way to hand the browser its URL, since a server
 * cannot follow a redirect itself.
 */

/** Everything the SDK keeps for one connector, sealed together on its row. */
export interface OAuthRecord {
	clientInformation?: OAuthClientInformation;
	authorizationServer?: OAuthAuthorizationServerInformation;
	tokens?: OAuthTokens;
	/** Of a sign-in under way. */
	codeVerifier?: string;
	state?: string;
	/** Who started the sign-in under way, the only member who may finish it. */
	startedByMemberId?: string;
	startedBySessionId?: string;
	/**
	 * When the authorization server last refused the tokens and no one was
	 * there to sign in again, as an ISO timestamp. Cleared by the next tokens.
	 */
	signInRejectedAt?: string;
}

/** Where a connector's record lives, and the clock its changes are stamped by. */
interface OAuthStorage {
	load(): Promise<OAuthRecord | undefined>;
	/**
	 * Answers whether `record` was saved. `signedInById` comes with the tokens
	 * a sign-in has just been issued, as the member who finished it, and is
	 * refused once they are no longer in the workspace. Anything saved without
	 * it, such as refreshed tokens, is refused once the record has changed
	 * since it was loaded or last saved, so nothing read before a sign-out
	 * writes its tokens back.
	 */
	save(record: OAuthRecord, signedInById?: string): Promise<boolean>;
	now(): Promise<Date>;
}

interface OAuthProviderOptions {
	/** Where the authorization server sends the browser back: the API's callback route. */
	redirectUrl: string;
	clientName: string;
	/**
	 * Who is starting a sign-in, recorded with its `state`. Left out by a
	 * provider that only uses or refreshes tokens, which refuses to start a
	 * sign-in, since nobody could finish it, and throws {@link SignInRequired}.
	 */
	startedByMemberId?: string;
	startedBySessionId?: string;
	/** Who is finishing a sign-in, as whom the tokens it is issued sign in. */
	finishedByMemberId?: string;
}

/** The SDK's provider, plus the authorization URL it was asked to send the browser to. */
interface StoredOAuthProvider extends OAuthClientProvider {
	authorizationUrl(): URL | undefined;
	assertExchange(): void;
	rejectTokens(): Promise<never>;
}

export function storedOAuthProvider(
	storage: OAuthStorage,
	{
		redirectUrl,
		clientName,
		startedByMemberId,
		startedBySessionId,
		finishedByMemberId,
	}: OAuthProviderOptions,
): StoredOAuthProvider {
	let cached: Promise<OAuthRecord> | undefined;
	let authorizationUrl: URL | undefined;
	let conflicted = false;
	const assertExchange = () => {
		if (conflicted) throw new SignInRequired();
	};
	const record = () => {
		assertExchange();
		cached ??= storage.load().then((loaded) => loaded ?? {});
		return cached;
	};
	const change = async (patch: Partial<OAuthRecord>, signedInById?: string) => {
		const changed = { ...(await record()), ...patch };
		assertExchange();
		if (await storage.save(changed, signedInById)) {
			cached = Promise.resolve(changed);
			return;
		}
		conflicted = true;
		throw new SignInRequired();
	};

	return {
		get redirectUrl() {
			return redirectUrl;
		},
		get clientMetadata() {
			return {
				client_name: clientName,
				redirect_uris: [redirectUrl],
				grant_types: ["authorization_code", "refresh_token"],
				response_types: ["code"],
				token_endpoint_auth_method: "none",
			};
		},
		authorizationUrl: () => authorizationUrl,
		assertExchange,
		rejectTokens: async () => {
			const rejectedAt = await storage.now();
			await change({ tokens: undefined, signInRejectedAt: rejectedAt.toISOString() });
			throw new SignInRequired();
		},
		clientInformation: async () => (await record()).clientInformation,
		saveClientInformation: (clientInformation) => change({ clientInformation }),
		authorizationServerInformation: async () => (await record()).authorizationServer,
		saveAuthorizationServerInformation: (authorizationServer) => change({ authorizationServer }),
		tokens: async () => (await record()).tokens,
		// Only an authorization code is exchanged while a sign-in finishes, so these are
		// its tokens, saved with its state and verifier cleared, all under the lock that
		// orders them with a removal of the member finishing it.
		saveTokens: (tokens) =>
			change(
				finishedByMemberId === undefined
					? { tokens, signInRejectedAt: undefined }
					: {
							tokens,
							signInRejectedAt: undefined,
							state: "",
							startedByMemberId: undefined,
							startedBySessionId: undefined,
							codeVerifier: undefined,
						},
				finishedByMemberId,
			),
		codeVerifier: async () => {
			const verifier = (await record()).codeVerifier;
			if (!verifier) throw new Error("No sign-in is under way for this connector");
			return verifier;
		},
		saveCodeVerifier: (codeVerifier) => change({ codeVerifier }),
		state: async () => {
			if (startedBySessionId === undefined) throw new SignInRequired();
			return randomBytes(24).toString("base64url");
		},
		saveState: (state) => change({ state, startedByMemberId, startedBySessionId }),
		storedState: async () => (await record()).state,
		redirectToAuthorization: (url) => {
			authorizationUrl = url;
		},
		invalidateCredentials: async (scope) => {
			const current = await record();
			await change({
				tokens: scope === "all" || scope === "tokens" ? undefined : current.tokens,
				clientInformation:
					scope === "all" || scope === "client" ? undefined : current.clientInformation,
				codeVerifier: scope === "all" || scope === "verifier" ? undefined : current.codeVerifier,
			});
		},
	};
}

/** Where a sign-in got to: somewhere for the browser to go, or already done. */
export type OAuthSignIn = { authorizationUrl: string } | { authorized: true };

/**
 * Starts a sign-in, or finds one is not needed. The browser is sent to the
 * URL that comes back; the connector's `state` is what the callback matches.
 */
export async function beginAuthorization(
	provider: StoredOAuthProvider,
	serverUrl: string,
	fetch: EgressHttpClient,
): Promise<OAuthSignIn> {
	const result = await auth(provider, { serverUrl, fetchFn: fetch });
	provider.assertExchange();
	if (result === "AUTHORIZED") return { authorized: true };
	const url = provider.authorizationUrl();
	if (!url) throw new Error("The authorization server gave no address to sign in at");
	return { authorizationUrl: url.toString() };
}

/**
 * Finishes a sign-in with the code the browser brought back, leaving tokens on
 * the record and its state cleared, in one save.
 */
export async function finishAuthorization(
	provider: StoredOAuthProvider,
	serverUrl: string,
	code: string,
	state: string,
	fetch: EgressHttpClient,
): Promise<void> {
	const result = await auth(provider, {
		serverUrl,
		authorizationCode: code,
		callbackState: state,
		fetchFn: fetch,
	});
	provider.assertExchange();
	if (result !== "AUTHORIZED") {
		throw new Error("The authorization server did not accept the sign-in");
	}
}

/** Handles the MCP challenge here so the OAuth exchange can hold one connector claim. */
export function oauthClient(
	fetch: EgressHttpClient,
	serverUrl: string,
	tokens: () => Promise<OAuthTokens | undefined>,
	refresh: (
		signal: AbortSignal,
		challenge: Response,
		rejected: string | undefined,
	) => Promise<OAuthTokens | undefined>,
): OAuthClient {
	const endpoint = new URL(serverUrl).href;
	const sentTokens = new Set<string>();
	return {
		sentTokens: () => sentTokens,
		fetch: async (input, init) => {
			const request = new Request(input, init);
			if (request.url !== endpoint) throw new SignInRequired();
			const send = (accessToken: string | undefined) => {
				request.signal.throwIfAborted();
				const headers = new Headers(request.headers);
				if (accessToken) {
					headers.set("authorization", `Bearer ${accessToken}`);
					sentTokens.add(accessToken);
				}
				return fetch(input, { ...init, headers });
			};
			const accessToken = (await tokens())?.access_token;
			const response = await send(accessToken);
			if (response.status !== 401 || request.method === "DELETE") return response;
			await response.body?.cancel();
			const refreshed = await refresh(request.signal, response, accessToken);
			if (!refreshed) throw new SignInRequired();
			return send(refreshed.access_token);
		},
	};
}

export async function refreshAuthorization(
	provider: StoredOAuthProvider,
	serverUrl: string,
	challenge: Response,
	fetch: EgressHttpClient,
): Promise<OAuthTokens | undefined> {
	let refreshError: { cause: unknown } | undefined;
	let refreshSent = false;
	let refreshRefused = false;
	let refreshClientRefused = false;
	const fetchForRefresh: EgressHttpClient = async (input, init) => {
		if (
			!(init?.body instanceof URLSearchParams) ||
			init.body.get("grant_type") !== "refresh_token"
		) {
			return fetch(input, init);
		}
		refreshSent = true;
		try {
			const response = await fetch(input, init);
			refreshRefused = response.status >= 400 && response.status < 500;
			if (refreshRefused) {
				const refusal: unknown = await response
					.clone()
					.json()
					.catch(() => undefined);
				refreshClientRefused =
					typeof refusal === "object" &&
					refusal !== null &&
					"error" in refusal &&
					(refusal.error === "invalid_client" || refusal.error === "unauthorized_client");
			}
			if (!response.ok) {
				const cause = new Error(`The OAuth token endpoint returned HTTP ${response.status}`);
				if (response.status >= 500) {
					await response.body?.cancel();
					throw cause;
				}
				refreshError = { cause };
			}
			return response;
		} catch (cause) {
			refreshError = { cause };
			throw cause;
		}
	};
	const result = await auth(
		{
			...provider,
			state: async () => {
				// The SDK falls through to interactive sign-in after a transport error.
				if (!refreshSent) return provider.rejectTokens();
				if (refreshError) throw refreshError.cause;
				throw new SignInRequired();
			},
			invalidateCredentials: async (scope) => {
				// The SDK also invalidates unbound credentials before the exchange.
				// The SDK asks to invalidate tokens after a refused refresh with invalid_grant.
				if (scope === "tokens" && (!refreshSent || refreshRefused)) return provider.rejectTokens();
				throw new SignInRequired();
			},
		},
		{
			serverUrl,
			...extractWWWAuthenticateParams(challenge),
			fetchFn: fetchForRefresh,
		},
	).catch((cause) => {
		if (refreshClientRefused) return provider.rejectTokens();
		throw cause;
	});
	provider.assertExchange();
	return result === "AUTHORIZED" ? provider.tokens() : undefined;
}

/** Why a sign-in could not start: see {@link signInStartFailure}. */
export type SignInStartFailure = "registration_unsupported" | "unreachable" | "unknown";

/**
 * signInStartFailure returns why `cause`, thrown while starting a sign-in,
 * stopped it: the authorization server offers no dynamic client registration,
 * which is the only way Sugabots registers, or no server answered at all.
 */
export function signInStartFailure(cause: unknown): SignInStartFailure {
	for (const current of causesOf(cause)) {
		if (!(current instanceof Error)) break;
		if (/does not support dynamic client registration/.test(current.message)) {
			return "registration_unsupported";
		}
		const code = (current as { code?: unknown }).code;
		if (current.name === "TimeoutError" || (typeof code === "string" && /^E[A-Z]+$/.test(code))) {
			return "unreachable";
		}
	}
	return "unknown";
}

/**
 * The authorization server refused the connector's tokens, and only a member
 * signing in again can fix it.
 */
export class SignInRequired extends Error {
	override readonly name = "SignInRequired";
	constructor() {
		super("The connector needs signing in again");
	}
}

/** Whether a failure, or what caused it, means the connector needs signing in again rather than fixing. */
export function needsSignIn(cause: unknown): boolean {
	return causesOf(cause).some(
		(current) => current instanceof SignInRequired || current instanceof UnauthorizedError,
	);
}

/** Providers backed by the connector table, one per connector asked for. */
export interface OAuthClient {
	readonly fetch: EgressHttpClient;
	readonly sentTokens: () => ReadonlySet<string>;
}

export interface OAuthProviders {
	for(workspaceId: string, connectorId: string, serverUrl: string): OAuthClient;
}
