import {
	type BuiltInProviderId,
	builtInSignInService,
	type SignInServiceId,
	signInServiceNames,
} from "@sugabots/contracts";
import { ProviderSignInFailed } from "@sugabots/contracts/errors/providers";
import { type DomainError, userText } from "@sugabots/errors";
import { Clock, Effect, ErrorReporter, Schema } from "effect";
import type { EgressHttpClient, EgressHttpClients } from "../../network/egress.ts";
import type { ModelProviderStore } from "../model-provider-store.ts";
import { chatgpt } from "./chatgpt.ts";
import { xai } from "./xai.ts";

/**
 * Signing a model provider in with a member's subscription, such as ChatGPT
 * Plus or SuperGrok, so its requests draw on their plan rather than API
 * credit. Each service is signed in to with a device code, the only OAuth
 * flow a server can use with the command-line clients these borrow: those
 * clients accept no redirect but `localhost`.
 */

/** The OAuth tokens a signed-in provider holds, sealed in its row. */
export const OAuthTokens = Schema.Struct({
	access: Schema.String,
	refresh: Schema.String,
	/** Epoch milliseconds. */
	expiresAt: Schema.Number,
	/** The account the plan belongs to, for a service whose requests name it (ChatGPT's workspace). */
	accountId: Schema.NullOr(Schema.String),
});
export type OAuthTokens = typeof OAuthTokens.Type;

/** A device code waiting for the member to enter it at `verificationUrl`. */
interface DeviceCode {
	/** The service's secret for this sign-in, which it asks for back when the code is redeemed. */
	deviceCode: string;
	userCode: string;
	verificationUrl: string;
	pollIntervalMs: number;
	expiresAt: number;
}

/** One service's sign-in. Every request goes through an egress client for `issuer`. */
export interface SubscriptionSignIn {
	readonly issuer: string;
	/** Asks the service for a code the member enters to sign in. */
	readonly requestDeviceCode: (
		http: EgressHttpClient,
	) => Effect.Effect<DeviceCode, ProviderSignInFailed>;
	/** `undefined` while the member has not entered the code; the tokens once they have. */
	readonly redeemDeviceCode: (
		http: EgressHttpClient,
		code: Pick<DeviceCode, "deviceCode" | "userCode">,
	) => Effect.Effect<OAuthTokens | undefined, ProviderSignInFailed>;
	/**
	 * Trades the refresh token for new tokens. A service may rotate refresh
	 * tokens, spending the old one, so the result must be stored before
	 * anything else uses it.
	 */
	readonly refresh: (
		http: EgressHttpClient,
		tokens: OAuthTokens,
	) => Effect.Effect<OAuthTokens, ProviderSignInFailed>;
	/** The headers besides the bearer token that the service's model API wants. */
	readonly requestHeaders: (tokens: OAuthTokens) => Record<string, string>;
}

/** The cause of a sign-in service's refusal to issue tokens: the status it answered with. */
export class TokenRefused
	extends Schema.TaggedError<TokenRefused>()("TokenRefused", { status: Schema.Int })
	implements DomainError
{
	readonly isRetryable = false;
	override readonly [ErrorReporter.severity] = "Warn" as const;
	override get message() {
		return `The sign-in service refused to issue tokens (${this.status})`;
	}
	get userMessage() {
		return userText`The sign-in service refused to issue tokens (${this.status}); sign in again`;
	}
}

/**
 * Whether `failure`, a refresh's, is the service answering that the refresh
 * token no longer refreshes, so the sign-in must be made again. Any other
 * failure, unanswered or unreadable, may have spent the token or not.
 */
export const refreshRefused = (failure: ProviderSignInFailed) =>
	failure.cause instanceof TokenRefused &&
	(failure.cause.status === 400 || failure.cause.status === 401);

/** The sign-in of a provider made from `builtIn`, if it is signed in to rather than given a key. */
export function signInFor(builtIn: BuiltInProviderId | null): SubscriptionSignIn | undefined {
	const service = builtInSignInService(builtIn);
	return service ? signInTo(service) : undefined;
}

/** Chosen when called rather than held in a table, since the implementations import this module. */
function signInTo(service: SignInServiceId): SubscriptionSignIn {
	switch (service) {
		case "chatgpt":
			return chatgpt;
		case "xai":
			return xai;
	}
}

/**
 * How long before expiry a token is replaced. Refreshed once, before a turn
 * starts, a token has to outlast every step of that turn.
 */
const REFRESH_MARGIN_MS = 15 * 60_000;
const REQUEST_TIMEOUT_MS = 15_000;

const needsRefresh = (tokens: OAuthTokens) =>
	Clock.currentTimeMillis.pipe(Effect.map((now) => tokens.expiresAt - now < REFRESH_MARGIN_MS));

/**
 * The provider access ready to send: for a signed-in provider, a live access token
 * as its key and its service's headers, refreshing the token first if it is
 * close to expiring. Any other provider access is returned as it is.
 */
export function withSignInAccess(
	store: Pick<ModelProviderStore.Interface, "renewOAuthTokens">,
	httpClients: EgressHttpClients,
	workspaceId: string,
	access: ModelProviderStore.ProviderAccess,
): Effect.Effect<ModelProviderStore.ProviderAccess, ProviderSignInFailed> {
	const service = builtInSignInService(access.builtIn);
	if (!service || !access.oauthTokens) return Effect.succeed(access);
	const signIn = signInTo(service);
	const http = httpClients.for({ baseUrl: signIn.issuer });
	return Effect.gen(function* () {
		const tokens = yield* store.renewOAuthTokens(workspaceId, access.providerId, {
			configurationRevision: access.configurationRevision,
			isStale: needsRefresh,
			refresh: (current) => signIn.refresh(http, current),
			lapsedBecause: (failure) => (refreshRefused(failure) ? failure.userMessage : undefined),
		});
		if (!tokens) {
			return yield* new ProviderSignInFailed({
				userMessage: userText`Sign in to ${signInServiceNames[service]} again`,
			});
		}
		return {
			...access,
			apiKey: tokens.access,
			headers: { ...access.headers, ...signIn.requestHeaders(tokens) },
		};
	});
}

type ServiceName = (typeof signInServiceNames)[SignInServiceId];

/** A POST to a sign-in service, as JSON or as a form, that fails as `ProviderSignInFailed`. */
export function postToSignIn(
	http: EgressHttpClient,
	service: ServiceName,
	url: string,
	body: { json: Record<string, string> } | { form: Record<string, string> },
): Effect.Effect<Response, ProviderSignInFailed> {
	return Effect.tryPromise({
		try: () =>
			http(url, {
				method: "POST",
				headers: {
					accept: "application/json",
					"content-type": "json" in body ? "application/json" : "application/x-www-form-urlencoded",
				},
				body:
					"json" in body ? JSON.stringify(body.json) : new URLSearchParams(body.form).toString(),
				signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
			}),
		catch: (cause) =>
			new ProviderSignInFailed({ userMessage: userText`Could not reach ${service}`, cause }),
	});
}

/** A sign-in service's JSON answer read as `schema`. */
export function decodeSignInBody<A>(
	response: Response,
	service: ServiceName,
	schema: Schema.Decoder<A>,
): Effect.Effect<A, ProviderSignInFailed> {
	return Effect.tryPromise({
		try: () => response.json(),
		catch: (cause) =>
			new ProviderSignInFailed({
				userMessage: userText`${service} answered unreadably`,
				cause,
			}),
	}).pipe(
		Effect.flatMap((body) => Schema.decodeUnknownEffect(schema)(body)),
		Effect.mapError((cause) =>
			cause instanceof ProviderSignInFailed
				? cause
				: new ProviderSignInFailed({
						userMessage: userText`${service} answered unexpectedly`,
						cause,
					}),
		),
	);
}

/**
 * The claims of a JWT a sign-in service issued, read without verifying the
 * signature: the token came straight from the service over TLS, and only the
 * service checks it.
 */
export function unverifiedClaims<Claims>(token: string): Claims | undefined {
	const payload = token.split(".")[1];
	if (!payload) return undefined;
	try {
		return JSON.parse(Buffer.from(payload, "base64url").toString()) as Claims;
	} catch {
		return undefined;
	}
}
