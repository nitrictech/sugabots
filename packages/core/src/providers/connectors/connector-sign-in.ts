export * as ConnectorSignIn from "./connector-sign-in.ts";

import { setTimeout as delay } from "node:timers/promises";
import { CONNECTOR_OAUTH_REDIRECT_PATH } from "@sugabots/contracts";
import { API_BASE_PATH } from "@sugabots/contracts/http";
import { type DomainError, userText } from "@sugabots/errors";
import { Context, DateTime, Effect, ErrorReporter, Layer, Schema } from "effect";
import { ServerSettings } from "../../server-settings/server-settings.ts";
import { processLayer, Tier } from "../../tiers.ts";
import { Egress } from "../network/egress.ts";
import {
	ConnectorStore,
	OAUTH_EXCHANGE_CLAIM_MS,
	type OAuthExchangeClaim,
	type OAuthVersion,
} from "./connector-store.ts";
import {
	beginAuthorization,
	finishAuthorization,
	type OAuthProviders,
	type OAuthSignIn,
	oauthClient,
	refreshAuthorization,
	SignInRequired,
	storedOAuthProvider,
} from "./oauth.ts";

const EXCHANGE_TIMEOUT_MS = 20_000;
const CLAIM_RETRY_MS = 100;

/**
 * Signing connectors in through their servers' own OAuth, and the clients
 * that carry the tokens afterwards. Each client keeps what it learns on its
 * connector's row, and sends the browser back to the API's callback route.
 */
export interface Interface {
	/**
	 * The connectors' OAuth clients. Their saves run in the context this is
	 * read in, so they are traced under the request or turn that caused them.
	 */
	readonly clients: Effect.Effect<OAuthProviders>;
	/**
	 * Starts signing a connector in to the server at `serverUrl`, or finds it
	 * already is. Only `startedBySessionId` may finish the sign-in.
	 */
	readonly begin: (input: {
		workspaceId: string;
		connectorId: string;
		serverUrl: string;
		startedByMemberId: string;
		startedBySessionId: string;
	}) => Effect.Effect<OAuthSignIn, SignInFailed>;
	/**
	 * Exchanges the `code` the browser brought back for tokens, kept on the
	 * connector's row as `finishedByMemberId`'s sign-in.
	 */
	readonly finish: (
		workspaceId: string,
		connectorId: string,
		serverUrl: string,
		callback: { code: string; state: string },
		finishedByMemberId: string,
	) => Effect.Effect<void, SignInFailed>;
}

export class Service extends Context.Service<Service, Interface>()(
	"@sugabots/core/ConnectorSignIn",
) {
	declare readonly [Tier]: "process";
}

export const make = Effect.gen(function* () {
	const connectors = yield* ConnectorStore.Service;
	const egress = yield* Egress.Service;
	const serverSettings = yield* ServerSettings.Service;
	const redirectUrl = `${serverSettings.publicUrl}${API_BASE_PATH}${CONNECTOR_OAUTH_REDIRECT_PATH}`;

	const providerFor = (
		context: Context.Context<never>,
		workspaceId: string,
		connectorId: string,
		serverUrl: string,
		signIn?:
			| { startedByMemberId: string; startedBySessionId: string }
			| { finishedByMemberId: string },
		claim?: OAuthExchangeClaim,
	) => {
		const run = Effect.runPromiseWith(context);
		// The version the provider last read or wrote, which its next save must still find.
		let version: OAuthVersion = null;
		return storedOAuthProvider(
			{
				load: async () => {
					const read = await run(connectors.readOauthRecord(workspaceId, connectorId, serverUrl));
					if (!read) throw new SignInRequired();
					version = read.version;
					return read.record;
				},
				save: async (record, signedInById) => {
					const saved = await run(
						connectors.saveOauthRecord(
							workspaceId,
							connectorId,
							record,
							signedInById === undefined
								? { kind: "since", version, claim }
								: { kind: "signIn", signedInById, version, claim },
						),
					);
					if (saved === undefined) return false;
					version = saved;
					return true;
				},
				now: () => run(DateTime.nowAsDate),
			},
			{ redirectUrl, clientName: "Sugabots", ...signIn },
		);
	};

	const withClaim = async <A>(
		context: Context.Context<never>,
		workspaceId: string,
		connectorId: string,
		serverUrl: string,
		use: (claim: OAuthExchangeClaim, fetch: typeof egress.oauth) => Promise<A>,
		caller?: AbortSignal,
	): Promise<A> => {
		const run = Effect.runPromiseWith(context);
		const wait = AbortSignal.any([
			AbortSignal.timeout(OAUTH_EXCHANGE_CLAIM_MS),
			...(caller ? [caller] : []),
		]);
		while (true) {
			wait.throwIfAborted();
			const claim = await run(connectors.claimOauthExchange(workspaceId, connectorId, serverUrl));
			if (claim === undefined) throw new SignInRequired();
			if (claim === "busy") {
				await delay(CLAIM_RETRY_MS, undefined, { signal: wait });
				continue;
			}
			const signal = AbortSignal.any([
				AbortSignal.timeout(EXCHANGE_TIMEOUT_MS),
				...(caller ? [caller] : []),
			]);
			try {
				return await use(claim, (input, init) => egress.oauth(input, { ...init, signal }));
			} finally {
				await run(connectors.releaseOauthExchange(workspaceId, connectorId, claim));
			}
		}
	};

	const clients = Effect.map(
		Effect.context<never>(),
		(context): OAuthProviders => ({
			for: (workspaceId, connectorId, serverUrl) => {
				const run = Effect.runPromiseWith(context);
				// A session can outlive a refresh by another turn. Read its tokens on
				// every request and load the exchange's record again under the claim.
				const tokens = async () =>
					(await run(connectors.readOauthRecord(workspaceId, connectorId, serverUrl)))?.record
						?.tokens;
				return oauthClient(egress.oauth, serverUrl, tokens, (signal, challenge, rejected) =>
					withClaim(
						context,
						workspaceId,
						connectorId,
						serverUrl,
						async (claim, fetch) => {
							const exchange = providerFor(
								context,
								workspaceId,
								connectorId,
								serverUrl,
								undefined,
								claim,
							);
							const current = await exchange.tokens();
							if (current?.access_token !== rejected) return current;
							return refreshAuthorization(exchange, serverUrl, challenge, fetch);
						},
						signal,
					),
				);
			},
		}),
	);

	return Service.of({
		clients,

		begin: ({ workspaceId, connectorId, serverUrl, startedByMemberId, startedBySessionId }) =>
			Effect.flatMap(Effect.context<never>(), (context) =>
				Effect.tryPromise({
					try: (signal) =>
						withClaim(
							context,
							workspaceId,
							connectorId,
							serverUrl,
							(claim, fetch) =>
								beginAuthorization(
									providerFor(
										context,
										workspaceId,
										connectorId,
										serverUrl,
										{ startedByMemberId, startedBySessionId },
										claim,
									),
									serverUrl,
									fetch,
								),
							signal,
						),
					catch: (cause) => new SignInFailed({ step: "begin", cause }),
				}),
			).pipe(Effect.withSpan("ConnectorSignIn.begin")),

		// Under the exchange's claim, as beginning and refreshing are: the code is
		// good for one exchange, so nothing may save over the sign-in it finishes
		// between reading it and saving its tokens.
		finish: (workspaceId, connectorId, serverUrl, { code, state }, finishedByMemberId) =>
			Effect.flatMap(Effect.context<never>(), (context) =>
				Effect.tryPromise({
					try: (signal) =>
						withClaim(
							context,
							workspaceId,
							connectorId,
							serverUrl,
							(claim, fetch) =>
								finishAuthorization(
									providerFor(
										context,
										workspaceId,
										connectorId,
										serverUrl,
										{ finishedByMemberId },
										claim,
									),
									serverUrl,
									code,
									state,
									fetch,
								),
							signal,
						),
					catch: (cause) => new SignInFailed({ step: "finish", cause }),
				}),
			).pipe(Effect.withSpan("ConnectorSignIn.finish")),
	});
});

export const layerNoDeps = processLayer(Layer.effect(Service, make));

export const layer = layerNoDeps.pipe(Layer.provide(ConnectorStore.layer));

/**
 * The server or its authorization server would not start or finish a
 * sign-in. `cause` says why, for the logs; it is never shown.
 */
export class SignInFailed
	extends Schema.TaggedError<SignInFailed>()("SignInFailed", {
		step: Schema.Literals(["begin", "finish"]),
		cause: Schema.Defect(),
	})
	implements DomainError
{
	readonly isRetryable = true;
	override readonly [ErrorReporter.severity] = "Warn" as const;
	override get message() {
		return `Could not ${this.step} signing in: ${this.cause instanceof Error ? this.cause.message : String(this.cause)}`;
	}
	get userMessage() {
		return userText`Sugabots couldn't complete sign-in for the connector. Check its settings and try again.`;
	}
}
