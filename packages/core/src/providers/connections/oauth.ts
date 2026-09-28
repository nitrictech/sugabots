import { randomBytes } from "node:crypto";
import {
	auth,
	type OAuthAuthorizationServerInformation,
	type OAuthClientInformation,
	type OAuthClientProvider,
	type OAuthTokens,
	UnauthorizedError,
} from "@ai-sdk/mcp";
import type { EgressHttpClient } from "../network/egress.ts";

/**
 * Signing a connection in through the server's own OAuth (ADR 006, C14c).
 *
 * The AI SDK's client does the protocol: discovers the authorization server,
 * registers this installation as a client, sends the browser to sign in with
 * PKCE, exchanges the code, and refreshes tokens as they expire. What it needs
 * from us is somewhere to keep what it learns, which is one sealed record on
 * the connection row, and a way to hand the browser its URL, since a server
 * cannot follow a redirect itself.
 */

/** Everything the SDK keeps for one connection, sealed together on its row. */
export interface OAuthRecord {
	clientInformation?: OAuthClientInformation;
	authorizationServer?: OAuthAuthorizationServerInformation;
	tokens?: OAuthTokens;
	/** Of a sign-in under way. */
	codeVerifier?: string;
	state?: string;
}

/** Where a connection's record lives. */
export interface OAuthStorage {
	load(): Promise<OAuthRecord | undefined>;
	save(record: OAuthRecord): Promise<void>;
}

export interface OAuthProviderOptions {
	/** Where the authorization server sends the browser back: the API's callback route. */
	redirectUrl: string;
	clientName: string;
}

/** The SDK's provider, plus the authorization URL it was asked to send the browser to. */
export interface StoredOAuthProvider extends OAuthClientProvider {
	authorizationUrl(): URL | undefined;
}

export function storedOAuthProvider(
	storage: OAuthStorage,
	{ redirectUrl, clientName }: OAuthProviderOptions,
): StoredOAuthProvider {
	let cached: OAuthRecord | undefined;
	let authorizationUrl: URL | undefined;
	const record = async () => {
		cached ??= (await storage.load()) ?? {};
		return cached;
	};
	const change = async (patch: Partial<OAuthRecord>) => {
		cached = { ...(await record()), ...patch };
		await storage.save(cached);
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
		clientInformation: async () => (await record()).clientInformation,
		saveClientInformation: (clientInformation) => change({ clientInformation }),
		authorizationServerInformation: async () => (await record()).authorizationServer,
		saveAuthorizationServerInformation: (authorizationServer) => change({ authorizationServer }),
		tokens: async () => (await record()).tokens,
		saveTokens: (tokens) => change({ tokens }),
		codeVerifier: async () => {
			const verifier = (await record()).codeVerifier;
			if (!verifier) throw new Error("No sign-in is under way for this connection");
			return verifier;
		},
		saveCodeVerifier: (codeVerifier) => change({ codeVerifier }),
		state: () => randomBytes(24).toString("base64url"),
		saveState: (state) => change({ state }),
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
 * URL that comes back; the connection's `state` is what the callback matches.
 */
export async function beginAuthorization(
	provider: StoredOAuthProvider,
	serverUrl: string,
	fetch: EgressHttpClient,
): Promise<OAuthSignIn> {
	const result = await auth(provider, { serverUrl, fetchFn: fetch });
	if (result === "AUTHORIZED") return { authorized: true };
	const url = provider.authorizationUrl();
	if (!url) throw new Error("The authorization server gave no address to sign in at");
	return { authorizationUrl: url.toString() };
}

/** Finishes a sign-in with the code the browser brought back, leaving tokens on the record. */
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
	if (result !== "AUTHORIZED") {
		throw new Error("The authorization server did not accept the sign-in");
	}
	await provider.saveState?.("");
}

/** Whether a failure means the connection needs signing in again rather than fixing. */
export function needsSignIn(cause: unknown): boolean {
	return cause instanceof UnauthorizedError;
}

/** Providers backed by the connection table, one per connection asked for. */
export interface OAuthProviders {
	for(workspaceId: string, connectionId: string): StoredOAuthProvider;
}
