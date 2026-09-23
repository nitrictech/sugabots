import type { ConnectionTestResult, ConnectionUpdate, NewConnection } from "@sugabots/contracts";
import { Data, Effect } from "effect";
import type { Database } from "../../database/database.ts";
import type { Authorization } from "../../workspaces/access.ts";
import type { EgressHttpClient, EgressHttpClients, EgressUrlValidator } from "../network/egress.ts";
import { listServerTools, type ServerTarget } from "./mcp.ts";
import type {
	beginAuthorization,
	finishAuthorization,
	OAuthProviders,
	OAuthSignIn,
} from "./oauth.ts";
import type { ConnectionStore } from "./store.ts";

export class ConnectionNotFound extends Data.TaggedError("ConnectionNotFound") {
	override get message() {
		return "No such connection";
	}
}

export class ConnectionUrlNotAllowed extends Data.TaggedError("ConnectionUrlNotAllowed") {
	override get message() {
		return "Connection URL is not allowed by the network policy";
	}
}

export class ConnectionOAuthStartFailed extends Data.TaggedError("ConnectionOAuthStartFailed")<{
	readonly reason: string;
}> {
	override get message() {
		return `Could not start signing in: ${this.reason}`;
	}
}

export class ConnectionDoesNotUseOAuth extends Data.TaggedError("ConnectionDoesNotUseOAuth") {
	override get message() {
		return "This connection uses a secret, not OAuth";
	}
}

export class ConnectionNeededNoSignIn extends Data.TaggedError("ConnectionNeededNoSignIn") {
	override get message() {
		return "The server needed no sign-in";
	}
}

class ConnectionOAuthCompletionFailed extends Data.TaggedError("ConnectionOAuthCompletionFailed")<{
	readonly reason: string;
}> {
	override get message() {
		return this.reason;
	}
}

export type ConnectionOAuthOutcome =
	| { failed: string }
	| { connected: { connectionId: string; podId: string } };

export function connectionOperations({
	connections,
	authorization,
	httpClients,
	validateProviderUrl,
	listTools = listServerTools,
	oauth,
}: {
	connections: ConnectionStore;
	authorization: Authorization;
	httpClients: EgressHttpClients;
	validateProviderUrl: EgressUrlValidator;
	listTools?: typeof listServerTools;
	oauth: {
		providers: OAuthProviders;
		fetch: EgressHttpClient;
		begin: typeof beginAuthorization;
		finish: typeof finishAuthorization;
	};
}) {
	const requireConnection = (workspaceId: string, podId: string, connectionId: string) =>
		Effect.filterOrFail(
			connections.get(workspaceId, podId, connectionId),
			(found) => found != null,
			() => new ConnectionNotFound(),
		);

	const requireAllowedUrl = (url: string) =>
		Effect.tryPromise({
			try: () => validateProviderUrl(url),
			catch: () => new ConnectionUrlNotAllowed(),
		});

	const test = (
		workspaceId: string,
		podId: string,
		connectionId: string,
	): Effect.Effect<ConnectionTestResult, ConnectionNotFound, Database> =>
		Effect.gen(function* () {
			yield* requireConnection(workspaceId, podId, connectionId);
			const target = yield* connections.target(workspaceId, podId, connectionId);
			if (!target) {
				return yield* new ConnectionNotFound();
			}
			const started = Date.now();
			const server: ServerTarget = {
				url: target.url,
				headers: target.headers,
				authProvider:
					target.auth === "oauth" ? oauth.providers.for(workspaceId, connectionId) : undefined,
			};
			const found = yield* Effect.promise(() =>
				listTools(
					server,
					target.auth === "oauth" ? oauth.fetch : httpClients.for({ baseUrl: target.url }),
				),
			);
			yield* connections.recordTest(
				workspaceId,
				connectionId,
				target.configurationUpdatedAt,
				found.ok ? { tools: found.tools } : { error: found.reason },
			);
			return {
				reachable: found.ok,
				latencyMs: Date.now() - started,
				...(found.ok ? { tools: found.tools.length } : { error: found.reason }),
			};
		});

	const discoverQuietly = (workspaceId: string, podId: string, connectionId: string) =>
		test(workspaceId, podId, connectionId).pipe(Effect.catchCause(() => Effect.void));

	const startAuthorization = (workspaceId: string, connectionId: string, url: string) =>
		Effect.tryPromise({
			try: () => oauth.begin(oauth.providers.for(workspaceId, connectionId), url, oauth.fetch),
			catch: (cause) => new ConnectionOAuthStartFailed({ reason: reason(cause) }),
		});

	return {
		list: (workspaceId: string, podId: string) => connections.list(workspaceId, podId),
		get: requireConnection,

		create: (workspaceId: string, podId: string, userId: string, input: NewConnection) =>
			Effect.gen(function* () {
				yield* requireAllowedUrl(input.url);
				const made = yield* connections.create(workspaceId, podId, userId, input);
				if (input.auth !== "oauth") {
					yield* discoverQuietly(workspaceId, podId, made.id);
				}
				return yield* requireConnection(workspaceId, podId, made.id);
			}),

		update: (workspaceId: string, podId: string, connectionId: string, input: ConnectionUpdate) =>
			Effect.gen(function* () {
				yield* requireConnection(workspaceId, podId, connectionId);
				if (input.url) {
					yield* requireAllowedUrl(input.url);
				}
				const updated = yield* connections.update(workspaceId, podId, connectionId, input);
				if (!updated) {
					return yield* new ConnectionNotFound();
				}
				if (
					input.url === undefined &&
					input.secret === undefined &&
					input.secretHeader === undefined
				) {
					return updated;
				}
				yield* discoverQuietly(workspaceId, podId, connectionId);
				return yield* requireConnection(workspaceId, podId, connectionId);
			}),

		remove: (workspaceId: string, podId: string, connectionId: string) =>
			Effect.filterOrFail(
				connections.remove(workspaceId, podId, connectionId),
				(removed) => removed,
				() => new ConnectionNotFound(),
			).pipe(Effect.asVoid),

		test,

		connectFromCatalog: (
			workspaceId: string,
			podId: string,
			userId: string,
			input: Pick<NewConnection, "name" | "url">,
		) =>
			Effect.gen(function* () {
				yield* requireAllowedUrl(input.url);
				const made = yield* connections.create(workspaceId, podId, userId, {
					...input,
					auth: "oauth",
				});
				const started: OAuthSignIn = yield* startAuthorization(workspaceId, made.id, made.url).pipe(
					Effect.tapError(() =>
						connections.remove(workspaceId, podId, made.id).pipe(Effect.asVoid),
					),
				);
				if ("authorized" in started) {
					return yield* new ConnectionNeededNoSignIn();
				}
				return { connectionId: made.id, authorizationUrl: started.authorizationUrl };
			}),

		startOAuth: (workspaceId: string, podId: string, connectionId: string) =>
			Effect.gen(function* () {
				const found = yield* requireConnection(workspaceId, podId, connectionId);
				if (found.auth !== "oauth") {
					return yield* new ConnectionDoesNotUseOAuth();
				}
				const signIn = yield* startAuthorization(workspaceId, connectionId, found.url);
				if ("authorized" in signIn) {
					yield* discoverQuietly(workspaceId, podId, connectionId);
					return { authorizationUrl: null };
				}
				return { authorizationUrl: signIn.authorizationUrl };
			}),

		completeOAuth: (
			userId: string,
			{
				code,
				state,
				error,
				errorDescription,
			}: { code?: string; state?: string; error?: string; errorDescription?: string },
		) =>
			Effect.gen(function* () {
				if (!state) return failed("The sign-in came back without its state");
				const owner = yield* connections.byOauthState(state);
				if (!owner) return failed("The sign-in does not match any connection");
				// Asked again here, not carried over from the request that started
				// the sign-in: authority can be withdrawn while the caller is away
				// at the authorization server, and completing would store a
				// credential they may no longer manage.
				const stillAllowed = yield* Effect.result(
					authorization.pod(userId, owner.podId, "connection.manage"),
				);
				if (stillAllowed._tag === "Failure") {
					return failed("You are not allowed to connect a server in this pod");
				}
				if (error || !code) return failed(errorDescription || error || "The sign-in was refused");

				const found = yield* requireConnection(owner.workspaceId, owner.podId, owner.connectionId);
				const finished = yield* Effect.tryPromise({
					try: () =>
						oauth.finish(
							oauth.providers.for(owner.workspaceId, owner.connectionId),
							found.url,
							code,
							state,
							oauth.fetch,
						),
					catch: (cause) => new ConnectionOAuthCompletionFailed({ reason: reason(cause) }),
				}).pipe(Effect.result);
				if (finished._tag === "Failure") return failed(finished.failure.reason);

				yield* connections
					.update(owner.workspaceId, owner.podId, owner.connectionId, { enabled: true })
					.pipe(Effect.catch(() => Effect.void));
				yield* discoverQuietly(owner.workspaceId, owner.podId, owner.connectionId);
				return connected(owner.connectionId, owner.podId);
			}),
	};
}

function reason(cause: unknown): string {
	return cause instanceof Error ? cause.message : String(cause);
}

const failed = (message: string): ConnectionOAuthOutcome => ({ failed: message });
const connected = (connectionId: string, podId: string): ConnectionOAuthOutcome => ({
	connected: { connectionId, podId },
});
