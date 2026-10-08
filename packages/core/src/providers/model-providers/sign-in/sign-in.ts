import {
	type ProviderPresetId,
	presetSignInService,
	type SignInServiceId,
	signInServiceNames,
} from "@sugabots/contracts";
import { type UserText, userText } from "@sugabots/errors";
import { Clock, Data, Effect, Schema } from "effect";
import type { UserFacing } from "../../../user-message.ts";
import type { EgressHttpClient, EgressHttpClients } from "../../network/egress.ts";
import type { ModelProviderRepository } from "../model-provider-repository.ts";
import { chatgpt } from "./chatgpt.ts";
import { xai } from "./xai.ts";

/**
 * Signing a model provider in with a person's subscription, such as ChatGPT
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

/** A device code waiting for the person to enter it at `verificationUrl`. */
export interface DeviceCode {
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
	/** Asks the service for a code the person enters to sign in. */
	readonly requestDeviceCode: (
		http: EgressHttpClient,
	) => Effect.Effect<DeviceCode, ProviderSignInFailed>;
	/** `undefined` while the person has not entered the code; the tokens once they have. */
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

/** The sign-in of a provider made from `preset`, if it is signed in to rather than given a key. */
export function signInFor(preset: ProviderPresetId | null): SubscriptionSignIn | undefined {
	const service = presetSignInService(preset);
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

export class ProviderSignInFailed
	extends Data.TaggedError("ProviderSignInFailed")<{
		readonly userMessage: UserText;
		readonly cause?: unknown;
	}>
	implements UserFacing
{
	override get message() {
		return this.userMessage;
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
 * The connection ready to send: for a signed-in provider, a live access token
 * as its key and its service's headers, refreshing the token first if it is
 * close to expiring. Any other connection is returned as it is.
 */
export function withSignInAccess(
	store: Pick<ModelProviderRepository.Interface, "renewOAuthTokens">,
	httpClients: EgressHttpClients,
	workspaceId: string,
	connection: ModelProviderRepository.ProviderEndpoint,
): Effect.Effect<ModelProviderRepository.ProviderEndpoint, ProviderSignInFailed> {
	const service = presetSignInService(connection.preset);
	if (!service || !connection.oauthTokens) return Effect.succeed(connection);
	const signIn = signInTo(service);
	const http = httpClients.for({ baseUrl: signIn.issuer });
	return Effect.gen(function* () {
		const tokens = yield* store.renewOAuthTokens(workspaceId, connection.providerId, (current) =>
			needsRefresh(current).pipe(
				Effect.flatMap((stale) =>
					stale ? signIn.refresh(http, current) : Effect.succeed(current),
				),
			),
		);
		if (!tokens) {
			return yield* new ProviderSignInFailed({
				userMessage: userText`Sign in to ${signInServiceNames[service]} again`,
			});
		}
		return {
			...connection,
			apiKey: tokens.access,
			headers: { ...connection.headers, ...signIn.requestHeaders(tokens) },
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
