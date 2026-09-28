export * as ConnectionSignIn from "./connection-sign-in.ts";

import { CONNECTION_SIGN_IN_CALLBACK_PATH } from "@sugabots/contracts";
import { API_BASE_PATH } from "@sugabots/contracts/http";
import { Context, Data, Effect, Layer } from "effect";
import { Installation } from "../../installation/installation.ts";
import { Egress } from "../network/egress.ts";
import { ConnectionRepository } from "./connection-repository.ts";
import {
	beginAuthorization,
	finishAuthorization,
	type OAuthProviders,
	type OAuthSignIn,
	storedOAuthProvider,
} from "./oauth.ts";

/**
 * Signing connections in through their servers' own OAuth, and the clients
 * that carry the tokens afterwards. Each client keeps what it learns on its
 * connection's row, and sends the browser back to the API's callback route.
 */
export interface Interface {
	/**
	 * The connections' OAuth clients. Their saves run in the context this is
	 * read in, so they are traced under the request or turn that caused them.
	 */
	readonly clients: Effect.Effect<OAuthProviders>;
	/**
	 * Starts signing a connection in to the server at `serverUrl`, or finds it
	 * already is. Only `startedByUserId` may finish the sign-in.
	 */
	readonly begin: (input: {
		workspaceId: string;
		connectionId: string;
		serverUrl: string;
		startedByUserId: string;
	}) => Effect.Effect<OAuthSignIn, SignInFailed>;
	/** Exchanges the `code` the browser brought back for tokens, kept on the connection's row. */
	readonly finish: (
		workspaceId: string,
		connectionId: string,
		serverUrl: string,
		callback: { code: string; state: string },
	) => Effect.Effect<void, SignInFailed>;
}

export class Service extends Context.Service<Service, Interface>()(
	"@sugabots/core/ConnectionSignIn",
) {}

export const make = Effect.gen(function* () {
	const connections = yield* ConnectionRepository.Service;
	const egress = yield* Egress.Service;
	const installation = yield* Installation.Service;
	const redirectUrl = `${installation.publicUrl}${API_BASE_PATH}${CONNECTION_SIGN_IN_CALLBACK_PATH}`;

	const providerFor = (
		context: Context.Context<never>,
		workspaceId: string,
		connectionId: string,
		startedByUserId?: string,
	) =>
		storedOAuthProvider(
			{
				load: () =>
					Effect.runPromiseWith(context)(connections.oauthRecord(workspaceId, connectionId)),
				save: (record) =>
					Effect.runPromiseWith(context)(
						connections.saveOauthRecord(workspaceId, connectionId, record),
					),
			},
			{ redirectUrl, clientName: "Sugabots", startedByUserId },
		);

	const clients = Effect.map(
		Effect.context<never>(),
		(context): OAuthProviders => ({
			for: (workspaceId, connectionId) => providerFor(context, workspaceId, connectionId),
		}),
	);

	return Service.of({
		clients,

		begin: ({ workspaceId, connectionId, serverUrl, startedByUserId }) =>
			Effect.flatMap(Effect.context<never>(), (context) =>
				Effect.tryPromise({
					try: () =>
						beginAuthorization(
							providerFor(context, workspaceId, connectionId, startedByUserId),
							serverUrl,
							egress.oauth,
						),
					catch: (cause) => new SignInFailed({ step: "begin", cause }),
				}),
			).pipe(Effect.withSpan("ConnectionSignIn.begin")),

		finish: (workspaceId, connectionId, serverUrl, { code, state }) =>
			Effect.flatMap(clients, (providers) =>
				Effect.tryPromise({
					try: () =>
						finishAuthorization(
							providers.for(workspaceId, connectionId),
							serverUrl,
							code,
							state,
							egress.oauth,
						),
					catch: (cause) => new SignInFailed({ step: "finish", cause }),
				}),
			).pipe(Effect.withSpan("ConnectionSignIn.finish")),
	});
});

export const layerNoDeps = Layer.effect(Service, make);

export const layer = layerNoDeps.pipe(Layer.provide(ConnectionRepository.layer));

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
