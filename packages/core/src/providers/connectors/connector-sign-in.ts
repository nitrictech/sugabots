export * as ConnectorSignIn from "./connector-sign-in.ts";

import { CONNECTOR_SIGN_IN_CALLBACK_PATH } from "@sugabots/contracts";
import { API_BASE_PATH } from "@sugabots/contracts/http";
import { Context, Data, DateTime, Effect, Layer } from "effect";
import { ServerSettings } from "../../server-settings/server-settings.ts";
import { Egress } from "../network/egress.ts";
import { ConnectorStore } from "./connector-store.ts";
import {
	beginAuthorization,
	finishAuthorization,
	type OAuthProviders,
	type OAuthSignIn,
	storedOAuthProvider,
} from "./oauth.ts";

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
	 * already is. Only `startedByMemberId` may finish the sign-in.
	 */
	readonly begin: (input: {
		workspaceId: string;
		connectorId: string;
		serverUrl: string;
		startedByMemberId: string;
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
) {}

export const make = Effect.gen(function* () {
	const connectors = yield* ConnectorStore.Service;
	const egress = yield* Egress.Service;
	const serverSettings = yield* ServerSettings.Service;
	const redirectUrl = `${serverSettings.publicUrl}${API_BASE_PATH}${CONNECTOR_SIGN_IN_CALLBACK_PATH}`;

	const providerFor = (
		context: Context.Context<never>,
		workspaceId: string,
		connectorId: string,
		signIn?: { startedByMemberId: string } | { finishedByMemberId: string },
	) =>
		storedOAuthProvider(
			{
				load: () =>
					Effect.runPromiseWith(context)(connectors.oauthRecord(workspaceId, connectorId)),
				save: (record, signedInById) =>
					Effect.runPromiseWith(context)(
						connectors.saveOauthRecord(workspaceId, connectorId, record, signedInById),
					),
				now: () => Effect.runPromiseWith(context)(DateTime.nowAsDate),
			},
			{ redirectUrl, clientName: "Sugabots", ...signIn },
		);

	const clients = Effect.map(
		Effect.context<never>(),
		(context): OAuthProviders => ({
			for: (workspaceId, connectorId) => providerFor(context, workspaceId, connectorId),
		}),
	);

	return Service.of({
		clients,

		begin: ({ workspaceId, connectorId, serverUrl, startedByMemberId }) =>
			Effect.flatMap(Effect.context<never>(), (context) =>
				Effect.tryPromise({
					try: () =>
						beginAuthorization(
							providerFor(context, workspaceId, connectorId, { startedByMemberId }),
							serverUrl,
							egress.oauth,
						),
					catch: (cause) => new SignInFailed({ step: "begin", cause }),
				}),
			).pipe(Effect.withSpan("ConnectorSignIn.begin")),

		finish: (workspaceId, connectorId, serverUrl, { code, state }, finishedByMemberId) =>
			Effect.flatMap(Effect.context<never>(), (context) =>
				Effect.tryPromise({
					try: () =>
						finishAuthorization(
							providerFor(context, workspaceId, connectorId, { finishedByMemberId }),
							serverUrl,
							code,
							state,
							egress.oauth,
						),
					catch: (cause) => new SignInFailed({ step: "finish", cause }),
				}),
			).pipe(Effect.withSpan("ConnectorSignIn.finish")),
	});
});

export const layerNoDeps = Layer.effect(Service, make);

export const layer = layerNoDeps.pipe(Layer.provide(ConnectorStore.layer));

/**
 * The server or its authorization server would not start or finish a
 * sign-in. `cause` says why, for the logs; it is never shown.
 */
export class SignInFailed extends Data.TaggedError("SignInFailed")<{
	readonly step: "begin" | "finish";
	readonly cause: unknown;
}> {
	override get message() {
		const reason = this.cause instanceof Error ? this.cause.message : String(this.cause);
		return `Could not ${this.step} signing in: ${reason}`;
	}
}
