import { userText } from "@sugabots/errors";
import { Clock, Effect, Schema } from "effect";
import type { EgressHttpClient } from "../../network/egress.ts";
import {
	decodeSignInBody,
	type OAuthTokens,
	ProviderSignInFailed,
	postToSignIn,
	type SubscriptionSignIn,
	unverifiedClaims,
} from "./sign-in.ts";

/**
 * Signing in with a ChatGPT subscription the way Codex CLI does.
 *
 * None of this is a published API. It borrows Codex CLI's OAuth client and
 * sends Responses API requests to the Codex backend on chatgpt.com;
 * OpenAI can change or close it without notice. A ChatGPT
 * workspace's admin may have turned it off.
 */

const ISSUER = "https://auth.openai.com";
const CODEX_CLIENT_ID = "app_EMoamEEZ73f0CkXaXp7hrann";
const DEVICE_VERIFICATION_URL = `${ISSUER}/codex/device`;
const DEVICE_REDIRECT_URI = `${ISSUER}/deviceauth/callback`;
/** How long OpenAI keeps a device code redeemable. */
const DEVICE_CODE_LIFETIME_MS = 15 * 60_000;
const DEFAULT_POLL_INTERVAL_MS = 5_000;
/** Assumed when a token response leaves out `expires_in`, as Codex CLI does. */
const DEFAULT_TOKEN_LIFETIME_MS = 60 * 60_000;
const SERVICE = "ChatGPT";

/** Who the requests say they come from; the Codex backend asks every client to name itself. */
const ORIGINATOR = "sugabots";

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

export const chatgpt: SubscriptionSignIn = {
	issuer: ISSUER,

	requestDeviceCode: (http) =>
		Effect.gen(function* () {
			const response = yield* postToSignIn(
				http,
				SERVICE,
				`${ISSUER}/api/accounts/deviceauth/usercode`,
				{ json: { client_id: CODEX_CLIENT_ID } },
			);
			if (!response.ok) {
				return yield* new ProviderSignInFailed({
					userMessage: userText`ChatGPT refused to start a sign-in (${response.status})`,
				});
			}
			const code = yield* decodeSignInBody(response, SERVICE, DeviceCodeResponse);
			const interval = Number(code.interval);
			return {
				deviceCode: code.device_auth_id,
				userCode: code.user_code,
				verificationUrl: DEVICE_VERIFICATION_URL,
				pollIntervalMs: interval > 0 ? interval * 1000 : DEFAULT_POLL_INTERVAL_MS,
				expiresAt: (yield* Clock.currentTimeMillis) + DEVICE_CODE_LIFETIME_MS,
			};
		}),

	redeemDeviceCode: (http, code) =>
		Effect.gen(function* () {
			const response = yield* postToSignIn(
				http,
				SERVICE,
				`${ISSUER}/api/accounts/deviceauth/token`,
				{ json: { device_auth_id: code.deviceCode, user_code: code.userCode } },
			);
			// OpenAI answers a code nobody has entered yet with one of these.
			if (response.status === 403 || response.status === 404) return undefined;
			if (!response.ok) {
				return yield* new ProviderSignInFailed({
					userMessage: userText`ChatGPT sign-in failed (${response.status})`,
				});
			}
			const authorized = yield* decodeSignInBody(response, SERVICE, DeviceTokenResponse);
			return yield* requestTokens(http, {
				grant_type: "authorization_code",
				code: authorized.authorization_code,
				redirect_uri: DEVICE_REDIRECT_URI,
				client_id: CODEX_CLIENT_ID,
				code_verifier: authorized.code_verifier,
			});
		}),

	refresh: (http, tokens) =>
		requestTokens(http, {
			grant_type: "refresh_token",
			refresh_token: tokens.refresh,
			client_id: CODEX_CLIENT_ID,
		}).pipe(Effect.map((next) => ({ ...next, accountId: next.accountId ?? tokens.accountId }))),

	/**
	 * The ChatGPT workspace to bill, where that workspace's data must be served
	 * from, and who is asking.
	 */
	requestHeaders: (tokens) => {
		const found = unverifiedClaims<ChatgptClaims>(tokens.access);
		const residency =
			found?.chatgpt_compute_residency ?? found?.[AUTH_CLAIM]?.chatgpt_compute_residency;
		return {
			originator: ORIGINATOR,
			...(tokens.accountId ? { "ChatGPT-Account-Id": tokens.accountId } : {}),
			...(residency ? { "x-openai-internal-codex-residency": residency } : {}),
		};
	},
};

function requestTokens(
	http: EgressHttpClient,
	form: Record<string, string>,
): Effect.Effect<OAuthTokens, ProviderSignInFailed> {
	return Effect.gen(function* () {
		// Taken before asking, so the expiry errs early.
		const now = yield* Clock.currentTimeMillis;
		const response = yield* postToSignIn(http, SERVICE, `${ISSUER}/oauth/token`, { form });
		if (!response.ok) {
			return yield* new ProviderSignInFailed({
				userMessage: userText`ChatGPT would not issue a token (${response.status}); sign in again`,
			});
		}
		const tokens = yield* decodeSignInBody(response, SERVICE, TokenResponse);
		return {
			access: tokens.access_token,
			refresh: tokens.refresh_token,
			expiresAt: now + (tokens.expires_in ? tokens.expires_in * 1000 : DEFAULT_TOKEN_LIFETIME_MS),
			accountId: accountIdFrom(tokens.id_token) ?? accountIdFrom(tokens.access_token) ?? null,
		};
	});
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
	const found = token ? unverifiedClaims<ChatgptClaims>(token) : undefined;
	return (
		found?.chatgpt_account_id ??
		found?.[AUTH_CLAIM]?.chatgpt_account_id ??
		found?.organizations?.[0]?.id
	);
}
