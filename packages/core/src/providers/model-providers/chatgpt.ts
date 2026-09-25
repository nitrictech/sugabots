import { Data, Effect, Schema } from "effect";
import type { Database } from "../../database/database.ts";
import type { EgressHttpClient, EgressHttpClients } from "../network/egress.ts";
import type { ModelProviderStore, ProviderConnection } from "./store.ts";

/**
 * Signing a model provider in with a person's ChatGPT subscription, the way
 * Codex CLI does, so its requests draw on their plan rather than API credit.
 *
 * None of this is a published API. It borrows Codex CLI's OAuth client and
 * sends Responses API requests to the Codex backend on chatgpt.com, as
 * OpenCode does; OpenAI can change or close it without notice. Only the
 * device-code sign-in is usable from a server: Codex's client accepts no
 * redirect but `localhost`. A ChatGPT workspace's admin may have turned it off.
 */

export const CHATGPT_ISSUER = "https://auth.openai.com";
const CODEX_CLIENT_ID = "app_EMoamEEZ73f0CkXaXp7hrann";
const DEVICE_VERIFICATION_URL = `${CHATGPT_ISSUER}/codex/device`;
const DEVICE_REDIRECT_URI = `${CHATGPT_ISSUER}/deviceauth/callback`;
/** How long OpenAI keeps a device code redeemable. */
const DEVICE_CODE_LIFETIME_MS = 15 * 60_000;
const DEFAULT_POLL_INTERVAL_MS = 5_000;
/** Assumed when a token response leaves out `expires_in`, as Codex CLI does. */
const DEFAULT_TOKEN_LIFETIME_MS = 60 * 60_000;
/**
 * How long before expiry a token is replaced. Refreshed once, before a turn
 * starts, a token has to outlast every step of that turn.
 */
const REFRESH_MARGIN_MS = 15 * 60_000;
const REQUEST_TIMEOUT_MS = 15_000;

/** Who the requests say they come from; the Codex backend asks every client to name itself. */
const ORIGINATOR = "sugabots";

/** What a signed-in provider holds, sealed in its row. */
export const ChatgptTokens = Schema.Struct({
	access: Schema.String,
	refresh: Schema.String,
	/** Epoch milliseconds. */
	expiresAt: Schema.Number,
	/** The ChatGPT workspace the plan belongs to; requests name it in a header. */
	accountId: Schema.NullOr(Schema.String),
});
export type ChatgptTokens = typeof ChatgptTokens.Type;

/** A device code waiting for the person to enter it at `verificationUrl`. */
export interface DeviceCode {
	deviceAuthId: string;
	userCode: string;
	verificationUrl: string;
	pollIntervalMs: number;
	expiresAt: number;
}

export class ChatgptSignInFailed extends Data.TaggedError("ChatgptSignInFailed")<{
	readonly message: string;
	readonly cause?: unknown;
}> {}

const DeviceCodeResponse = Schema.Struct({
	device_auth_id: Schema.String,
	user_code: Schema.String,
	interval: Schema.optional(Schema.Union([Schema.String, Schema.Number])),
});

const DeviceTokenResponse = Schema.Struct({
	authorization_code: Schema.String,
	code_verifier: Schema.String,
});

const TokenResponse = Schema.Struct({
	id_token: Schema.optional(Schema.String),
	access_token: Schema.String,
	refresh_token: Schema.String,
	expires_in: Schema.optional(Schema.Number),
});

/** Asks OpenAI for a code the person enters to sign in. `http` must reach `CHATGPT_ISSUER`. */
export function requestDeviceCode(
	http: EgressHttpClient,
	now = Date.now(),
): Effect.Effect<DeviceCode, ChatgptSignInFailed> {
	return Effect.gen(function* () {
		const response = yield* post(http, "/api/accounts/deviceauth/usercode", {
			json: { client_id: CODEX_CLIENT_ID },
		});
		if (!response.ok) {
			return yield* new ChatgptSignInFailed({
				message: `ChatGPT refused to start a sign-in (${response.status})`,
			});
		}
		const code = yield* decodeBody(response, DeviceCodeResponse);
		const interval = Number(code.interval);
		return {
			deviceAuthId: code.device_auth_id,
			userCode: code.user_code,
			verificationUrl: DEVICE_VERIFICATION_URL,
			pollIntervalMs: interval > 0 ? interval * 1000 : DEFAULT_POLL_INTERVAL_MS,
			expiresAt: now + DEVICE_CODE_LIFETIME_MS,
		};
	});
}

/**
 * Asks whether the person has entered the code yet. `undefined` while they
 * have not; the tokens once they have.
 */
export function redeemDeviceCode(
	http: EgressHttpClient,
	code: Pick<DeviceCode, "deviceAuthId" | "userCode">,
	now = Date.now(),
): Effect.Effect<ChatgptTokens | undefined, ChatgptSignInFailed> {
	return Effect.gen(function* () {
		const response = yield* post(http, "/api/accounts/deviceauth/token", {
			json: { device_auth_id: code.deviceAuthId, user_code: code.userCode },
		});
		// OpenAI answers a code nobody has entered yet with one of these.
		if (response.status === 403 || response.status === 404) return undefined;
		if (!response.ok) {
			return yield* new ChatgptSignInFailed({
				message: `ChatGPT sign-in failed (${response.status})`,
			});
		}
		const authorized = yield* decodeBody(response, DeviceTokenResponse);
		return yield* requestTokens(
			http,
			{
				grant_type: "authorization_code",
				code: authorized.authorization_code,
				redirect_uri: DEVICE_REDIRECT_URI,
				client_id: CODEX_CLIENT_ID,
				code_verifier: authorized.code_verifier,
			},
			now,
		);
	});
}

/**
 * Trades the refresh token for new tokens. OpenAI rotates refresh tokens, so
 * the old one is spent: the result must be stored before anything else uses it.
 */
export function refreshChatgptTokens(
	http: EgressHttpClient,
	tokens: ChatgptTokens,
	now = Date.now(),
): Effect.Effect<ChatgptTokens, ChatgptSignInFailed> {
	return requestTokens(
		http,
		{ grant_type: "refresh_token", refresh_token: tokens.refresh, client_id: CODEX_CLIENT_ID },
		now,
	).pipe(Effect.map((next) => ({ ...next, accountId: next.accountId ?? tokens.accountId })));
}

export function needsRefresh(tokens: ChatgptTokens, now = Date.now()): boolean {
	return tokens.expiresAt - now < REFRESH_MARGIN_MS;
}

/**
 * The headers besides the bearer token that the Codex backend wants: the
 * ChatGPT workspace to bill, where that workspace's data must be served
 * from, and who is asking.
 */
export function chatgptRequestHeaders(tokens: ChatgptTokens): Record<string, string> {
	const found = claims(tokens.access);
	const residency =
		found?.chatgpt_compute_residency ?? found?.[AUTH_CLAIM]?.chatgpt_compute_residency;
	return {
		originator: ORIGINATOR,
		...(tokens.accountId ? { "ChatGPT-Account-Id": tokens.accountId } : {}),
		...(residency ? { "x-openai-internal-codex-residency": residency } : {}),
	};
}

/**
 * The connection ready to send: for a ChatGPT provider, a live access token
 * as its key and the Codex backend's headers, refreshing the token first if
 * it is close to expiring. Any other connection is returned as it is.
 */
export function withChatgptAccess(
	store: Pick<ModelProviderStore, "renewChatgptTokens">,
	httpClients: EgressHttpClients,
	workspaceId: string,
	connection: ProviderConnection,
): Effect.Effect<ProviderConnection, ChatgptSignInFailed, Database> {
	if (!connection.chatgptTokens) return Effect.succeed(connection);
	const http = httpClients.for({ baseUrl: CHATGPT_ISSUER });
	return Effect.gen(function* () {
		const tokens = yield* store.renewChatgptTokens(workspaceId, connection.providerId, (current) =>
			needsRefresh(current) ? refreshChatgptTokens(http, current) : Effect.succeed(current),
		);
		if (!tokens) {
			return yield* new ChatgptSignInFailed({ message: "Sign in to ChatGPT again" });
		}
		return {
			...connection,
			apiKey: tokens.access,
			headers: { ...connection.headers, ...chatgptRequestHeaders(tokens) },
		};
	});
}

function requestTokens(
	http: EgressHttpClient,
	form: Record<string, string>,
	now: number,
): Effect.Effect<ChatgptTokens, ChatgptSignInFailed> {
	return Effect.gen(function* () {
		const response = yield* post(http, "/oauth/token", { form });
		if (!response.ok) {
			return yield* new ChatgptSignInFailed({
				message: `ChatGPT would not issue a token (${response.status}); sign in again`,
			});
		}
		const tokens = yield* decodeBody(response, TokenResponse);
		return {
			access: tokens.access_token,
			refresh: tokens.refresh_token,
			expiresAt: now + (tokens.expires_in ? tokens.expires_in * 1000 : DEFAULT_TOKEN_LIFETIME_MS),
			accountId: accountIdFrom(tokens.id_token) ?? accountIdFrom(tokens.access_token) ?? null,
		};
	});
}

function post(
	http: EgressHttpClient,
	path: string,
	body: { json: Record<string, string> } | { form: Record<string, string> },
): Effect.Effect<Response, ChatgptSignInFailed> {
	return Effect.tryPromise({
		try: () =>
			http(`${CHATGPT_ISSUER}${path}`, {
				method: "POST",
				headers: {
					"content-type": "json" in body ? "application/json" : "application/x-www-form-urlencoded",
				},
				body:
					"json" in body ? JSON.stringify(body.json) : new URLSearchParams(body.form).toString(),
				signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
			}),
		catch: (cause) => new ChatgptSignInFailed({ message: "Could not reach ChatGPT", cause }),
	});
}

function decodeBody<A>(
	response: Response,
	schema: Schema.Decoder<A>,
): Effect.Effect<A, ChatgptSignInFailed> {
	return Effect.tryPromise({
		try: () => response.json(),
		catch: (cause) => new ChatgptSignInFailed({ message: "ChatGPT answered unreadably", cause }),
	}).pipe(
		Effect.flatMap((body) => Schema.decodeUnknownEffect(schema)(body)),
		Effect.mapError((cause) =>
			cause instanceof ChatgptSignInFailed
				? cause
				: new ChatgptSignInFailed({ message: "ChatGPT answered unexpectedly", cause }),
		),
	);
}

/** Where OpenAI nests its own claims in the tokens it issues. */
const AUTH_CLAIM = "https://api.openai.com/auth";

interface ChatgptClaims {
	chatgpt_account_id?: string;
	chatgpt_compute_residency?: string;
	organizations?: Array<{ id?: string }>;
	"https://api.openai.com/auth"?: {
		chatgpt_account_id?: string;
		chatgpt_compute_residency?: string;
	};
}

function accountIdFrom(token: string | undefined): string | undefined {
	const found = token ? claims(token) : undefined;
	return (
		found?.chatgpt_account_id ??
		found?.[AUTH_CLAIM]?.chatgpt_account_id ??
		found?.organizations?.[0]?.id
	);
}

/**
 * The claims of a JWT OpenAI issued, read without verifying the signature:
 * the token came straight from OpenAI over TLS, and only OpenAI checks it.
 */
function claims(token: string): ChatgptClaims | undefined {
	const payload = token.split(".")[1];
	if (!payload) return undefined;
	try {
		return JSON.parse(Buffer.from(payload, "base64url").toString()) as ChatgptClaims;
	} catch {
		return undefined;
	}
}
