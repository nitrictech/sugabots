import { userText } from "@sugabots/errors";
import { Clock, Effect, Schema } from "effect";
import {
	decodeSignInBody,
	type OAuthTokens,
	ProviderSignInFailed,
	postToSignIn,
	type SubscriptionSignIn,
} from "./sign-in.ts";

/**
 * Signing in with a SuperGrok or X Premium+ subscription the way Grok Build
 * does: the standard OAuth device flow (RFC 8628) against xAI's sign-in
 * service, whose tokens `api.x.ai` takes in place of a key.
 *
 * It borrows Grok Build's OAuth client, which xAI can change or close
 * without notice. xAI also keeps its own list of which plans may call the
 * API this way, so a sign-in can succeed and requests still be refused.
 */

const ISSUER = "https://auth.x.ai";
const GROK_BUILD_CLIENT_ID = "b1a00492-073a-47ea-816f-4c329264a828";
/** `offline_access` is what earns a refresh token; the last two let the token call the API. */
const SCOPES = "openid profile email offline_access grok-cli:access api:access";
const DEVICE_CODE_GRANT = "urn:ietf:params:oauth:grant-type:device_code";
const DEFAULT_POLL_INTERVAL_MS = 5_000;
/** How much longer RFC 8628 says to wait between polls each time the service answers `slow_down`. */
const SLOW_DOWN_WAIT = "5 seconds";
/** Who the sign-in says it is for; xAI asks each client to name itself. */
const REFERRER = "sugabots";
/** Assumed when a token response leaves out `expires_in`. */
const DEFAULT_TOKEN_LIFETIME_MS = 60 * 60_000;
const SERVICE = "xAI";

const DeviceCodeResponse = Schema.Struct({
	device_code: Schema.String,
	user_code: Schema.String,
	verification_uri: Schema.String,
	verification_uri_complete: Schema.optional(Schema.String),
	expires_in: Schema.Number,
	interval: Schema.optional(Schema.Number),
});

const TokenResponse = Schema.Struct({
	access_token: Schema.String,
	/** Left out when a refresh does not rotate it. */
	refresh_token: Schema.optional(Schema.String),
	expires_in: Schema.optional(Schema.Number),
});

const TokenError = Schema.Struct({ error: Schema.String });

export const xai: SubscriptionSignIn = {
	issuer: ISSUER,

	requestDeviceCode: (http) =>
		Effect.gen(function* () {
			const now = yield* Clock.currentTimeMillis;
			const response = yield* postToSignIn(http, SERVICE, `${ISSUER}/oauth2/device/code`, {
				form: { client_id: GROK_BUILD_CLIENT_ID, scope: SCOPES, referrer: REFERRER },
			});
			if (!response.ok) {
				return yield* new ProviderSignInFailed({
					userMessage: userText`xAI refused to start a sign-in (${response.status})`,
				});
			}
			const code = yield* decodeSignInBody(response, SERVICE, DeviceCodeResponse);
			return {
				deviceCode: code.device_code,
				userCode: code.user_code,
				verificationUrl: code.verification_uri_complete ?? code.verification_uri,
				pollIntervalMs: code.interval ? code.interval * 1000 : DEFAULT_POLL_INTERVAL_MS,
				expiresAt: now + code.expires_in * 1000,
			};
		}),

	redeemDeviceCode: (http, code) =>
		Effect.gen(function* () {
			const now = yield* Clock.currentTimeMillis;
			const response = yield* postToSignIn(http, SERVICE, `${ISSUER}/oauth2/token`, {
				form: {
					grant_type: DEVICE_CODE_GRANT,
					client_id: GROK_BUILD_CLIENT_ID,
					device_code: code.deviceCode,
				},
			});
			if (response.ok) {
				return yield* tokensFrom(yield* decodeSignInBody(response, SERVICE, TokenResponse), now);
			}
			const { error } = yield* decodeSignInBody(response, SERVICE, TokenError);
			if (error === "authorization_pending") return undefined;
			// The page asks again once this answers, so holding the answer back is what slows it down.
			if (error === "slow_down") return yield* Effect.as(Effect.sleep(SLOW_DOWN_WAIT), undefined);
			return yield* new ProviderSignInFailed({
				userMessage:
					error === "access_denied"
						? userText`The xAI sign-in was declined`
						: error === "expired_token"
							? userText`This sign-in has expired; start again`
							: userText`xAI sign-in failed (${response.status})`,
			});
		}),

	refresh: (http, tokens) =>
		Effect.gen(function* () {
			const now = yield* Clock.currentTimeMillis;
			const response = yield* postToSignIn(http, SERVICE, `${ISSUER}/oauth2/token`, {
				form: {
					grant_type: "refresh_token",
					client_id: GROK_BUILD_CLIENT_ID,
					refresh_token: tokens.refresh,
				},
			});
			if (!response.ok) {
				return yield* new ProviderSignInFailed({
					userMessage: userText`xAI would not issue a token (${response.status}); sign in again`,
				});
			}
			const next = yield* decodeSignInBody(response, SERVICE, TokenResponse);
			return yield* tokensFrom(next, now, tokens.refresh);
		}),

	requestHeaders: () => ({}),
};

/**
 * Tokens from a token response, their expiry counted from `requestedAt` so it
 * errs early. A refresh that does not rotate the refresh token leaves it out,
 * so `previousRefresh` is kept.
 */
function tokensFrom(
	response: typeof TokenResponse.Type,
	requestedAt: number,
	previousRefresh?: string,
): Effect.Effect<OAuthTokens, ProviderSignInFailed> {
	const refresh = response.refresh_token ?? previousRefresh;
	if (!refresh) {
		return Effect.fail(
			new ProviderSignInFailed({ userMessage: userText`xAI gave no refresh token` }),
		);
	}
	return Effect.succeed({
		access: response.access_token,
		refresh,
		expiresAt:
			requestedAt + (response.expires_in ? response.expires_in * 1000 : DEFAULT_TOKEN_LIFETIME_MS),
		accountId: null,
	});
}
