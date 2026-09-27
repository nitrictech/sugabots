export * as ConnectionSetup from "./connection-setup.ts";

import type {
	Connection,
	ConnectionSignInFailure,
	ConnectionTestResult,
	ConnectionUpdate,
	NewConnection,
} from "@sugabots/contracts";
import { Clock, Context, Data, Effect, Layer } from "effect";
import { Credentials } from "../../credentials/credentials.ts";
import { serviceOperations } from "../../database/database.ts";
import { type UserFacing, UserMessage } from "../../user-message.ts";
import { authorization } from "../../workspaces/access.ts";
import { Egress } from "../network/egress.ts";
import { requireAllowedUrl, type UrlNotAllowed } from "../tested-configuration.ts";
import { connectionIn, connectionsIn, toConnection } from "./connection-reads.ts";
import { ConnectionRepository } from "./connection-repository.ts";
import { ConnectionSignIn } from "./connection-sign-in.ts";
import { listServerTools } from "./mcp.ts";

/**
 * Connecting a pod to MCP servers: checking an address against the egress
 * policy before it is stored, learning a server's tools, and signing in to one
 * through its own OAuth.
 */
export interface Interface {
	readonly list: (pod: InPod) => Effect.Effect<Connection[]>;
	readonly get: (input: InConnection) => Effect.Effect<Connection, ConnectionNotFound>;
	/** Learns a server's tools straight away, unless it waits on a sign-in. */
	readonly create: (
		input: InPod & { createdById: string; connection: NewConnection },
	) => Effect.Effect<
		Connection,
		UrlNotAllowed | ConnectionRepository.ConnectionNameTaken | ConnectionNotFound
	>;
	/** A new address or secret sends the connection back to learn its tools. */
	readonly update: (
		input: InConnection & { changes: ConnectionUpdate },
	) => Effect.Effect<
		Connection,
		ConnectionNotFound | UrlNotAllowed | ConnectionRepository.ConnectionNameTaken
	>;
	readonly remove: (input: InConnection) => Effect.Effect<void, ConnectionNotFound>;
	/** Asks the server for its tools, and records what it said against the configuration asked. */
	readonly test: (input: InConnection) => Effect.Effect<ConnectionTestResult, ConnectionNotFound>;
	/** Adds a catalogued server, which signs in with OAuth, and starts its sign-in. */
	readonly connectFromCatalog: (
		input: InPod & { createdById: string; server: { name: string; url: string } },
	) => Effect.Effect<
		{ connectionId: string; authorizationUrl: string },
		| UrlNotAllowed
		| ConnectionRepository.ConnectionNameTaken
		| ConnectionOAuthStartFailed
		| ConnectionNeededNoSignIn
	>;
	/** Where to send the browser to sign in, or `null` when the server is already signed in to. */
	readonly startOAuth: (
		input: InConnection,
	) => Effect.Effect<
		{ authorizationUrl: string | null },
		ConnectionNotFound | ConnectionDoesNotUseOAuth | ConnectionOAuthStartFailed
	>;
	/**
	 * Finishes a sign-in with what the authorization server sent back, for
	 * `userId` only while they may still manage the pod's connections.
	 */
	readonly completeOAuth: (input: {
		userId: string;
		callback: { code?: string; state?: string; error?: string; errorDescription?: string };
	}) => Effect.Effect<SignInOutcome, ConnectionNotFound>;
}

/** A pod, by its workspace and its own id. */
export interface InPod {
	workspaceId: string;
	podId: string;
}

/** One of a pod's connections. */
export interface InConnection extends InPod {
	connectionId: string;
}

/**
 * How a sign-in ended. `pod` is there once the sign-in is known to be for a
 * pod the caller manages, so the browser can be sent back to it.
 */
export type SignInOutcome = { pod: InPod } | { failure: ConnectionSignInFailure; pod?: InPod };

export class Service extends Context.Service<Service, Interface>()(
	"@sugabots/core/ConnectionSetup",
) {}

export const make = Effect.gen(function* () {
	const operation = yield* serviceOperations<Interface>("ConnectionSetup");
	const connections = yield* ConnectionRepository.Service;
	const signIn = yield* ConnectionSignIn.Service;
	const egress = yield* Egress.Service;
	const cipher = yield* Credentials.Service;

	const requireConnection = ({ workspaceId, podId, connectionId }: InConnection) =>
		Effect.filterOrFail(
			connectionIn(workspaceId, podId, connectionId, cipher),
			(found) => found !== undefined,
			() => new ConnectionNotFound(),
		);

	const test = (at: InConnection) =>
		Effect.gen(function* () {
			const target = yield* connections.target(at.workspaceId, at.podId, at.connectionId);
			if (!target) {
				return yield* new ConnectionNotFound();
			}
			const clients = yield* signIn.clients;
			const started = yield* Clock.currentTimeMillis;
			const found = yield* Effect.promise(() =>
				listServerTools(
					{
						url: target.url,
						headers: target.headers,
						authProvider:
							target.auth === "oauth" ? clients.for(at.workspaceId, at.connectionId) : undefined,
					},
					target.auth === "oauth" ? egress.oauth : egress.providers.for({ baseUrl: target.url }),
				),
			);
			const latencyMs = (yield* Clock.currentTimeMillis) - started;
			if (!found.ok) {
				yield* Effect.logWarning("Asking a connection's server for its tools failed", found.cause);
			}
			yield* connections.recordTest(
				at.workspaceId,
				at.connectionId,
				target.configurationUpdatedAt,
				found.ok ? { tools: found.tools } : { error: found.reason },
			);
			return {
				reachable: found.ok,
				latencyMs,
				...(found.ok ? { tools: found.tools.length } : { error: found.reason }),
			};
		});

	/** A test whose outcome is recorded on the connection rather than returned. */
	const discoverQuietly = (at: InConnection) =>
		test(at).pipe(
			Effect.asVoid,
			Effect.catchTag("ConnectionNotFound", () => Effect.void),
		);

	const startSignIn = (workspaceId: string, connectionId: string, url: string) =>
		signIn.begin(workspaceId, connectionId, url).pipe(
			Effect.tapError((failure) =>
				Effect.logWarning("A connection's sign-in did not start", failure),
			),
			Effect.mapError(() => new ConnectionOAuthStartFailed()),
		);

	return Service.of({
		list: ({ workspaceId, podId }) => operation("list", connectionsIn(workspaceId, podId, cipher)),

		get: (at) => operation("get", requireConnection(at)),

		create: ({ workspaceId, podId, createdById, connection }) =>
			operation(
				"create",
				Effect.gen(function* () {
					yield* requireAllowedUrl(egress, connection.url);
					const made = yield* connections.create(workspaceId, podId, createdById, connection);
					const at = { workspaceId, podId, connectionId: made.id };
					if (connection.auth !== "oauth") {
						yield* discoverQuietly(at);
					}
					return yield* requireConnection(at);
				}),
			),

		update: ({ changes, ...at }) =>
			operation(
				"update",
				Effect.gen(function* () {
					if (changes.url) {
						yield* requireAllowedUrl(egress, changes.url);
					}
					const updated = yield* connections.update(
						at.workspaceId,
						at.podId,
						at.connectionId,
						changes,
					);
					if (!updated) {
						return yield* new ConnectionNotFound();
					}
					if (
						changes.url === undefined &&
						changes.secret === undefined &&
						changes.secretHeader === undefined
					) {
						return toConnection(updated, cipher);
					}
					yield* discoverQuietly(at);
					return yield* requireConnection(at);
				}),
			),

		remove: ({ workspaceId, podId, connectionId }) =>
			operation(
				"remove",
				Effect.filterOrFail(
					connections.remove(workspaceId, podId, connectionId),
					(removed) => removed,
					() => new ConnectionNotFound(),
				).pipe(Effect.asVoid),
			),

		test: (at) => operation("test", test(at)),

		connectFromCatalog: ({ workspaceId, podId, createdById, server }) =>
			operation(
				"connectFromCatalog",
				Effect.gen(function* () {
					yield* requireAllowedUrl(egress, server.url);
					const made = yield* connections.create(workspaceId, podId, createdById, {
						...server,
						auth: "oauth",
					});
					const started = yield* startSignIn(workspaceId, made.id, made.url).pipe(
						Effect.tapError(() => connections.remove(workspaceId, podId, made.id)),
					);
					if ("authorized" in started) {
						return yield* new ConnectionNeededNoSignIn();
					}
					return { connectionId: made.id, authorizationUrl: started.authorizationUrl };
				}),
			),

		startOAuth: (at) =>
			operation(
				"startOAuth",
				Effect.gen(function* () {
					const found = yield* requireConnection(at);
					if (found.auth !== "oauth") {
						return yield* new ConnectionDoesNotUseOAuth();
					}
					const started = yield* startSignIn(at.workspaceId, at.connectionId, found.url);
					if ("authorized" in started) {
						yield* discoverQuietly(at);
						return { authorizationUrl: null };
					}
					return { authorizationUrl: started.authorizationUrl };
				}),
			),

		completeOAuth: ({ userId, callback }) =>
			operation(
				"completeOAuth",
				Effect.gen(function* () {
					if (!callback.state) return { failure: "missing_state" as const };
					const owner = yield* connections.byOauthState(callback.state);
					if (!owner) return { failure: "unknown_state" as const };
					// Asked again rather than carried over from the request that started
					// the sign-in: authority can be withdrawn while the person is away at
					// the authorization server, and completing would store a credential
					// they may no longer manage.
					const allowed = yield* Effect.result(
						authorization.pod(userId, owner.podId, "connection.manage"),
					);
					if (allowed._tag === "Failure") return { failure: "not_allowed" as const };

					const pod = { workspaceId: owner.workspaceId, podId: owner.podId };
					if (callback.error || !callback.code) {
						yield* Effect.logWarning("An authorization server refused a connection's sign-in", {
							error: callback.error,
							description: callback.errorDescription,
						});
						return { failure: "refused" as const, pod };
					}
					const at = { ...pod, connectionId: owner.connectionId };
					const found = yield* requireConnection(at);
					const finished = yield* Effect.result(
						signIn.finish(owner.workspaceId, owner.connectionId, found.url, {
							code: callback.code,
							state: callback.state,
						}),
					);
					if (finished._tag === "Failure") {
						yield* Effect.logWarning("A connection's sign-in did not finish", finished.failure);
						return { failure: "not_completed" as const, pod };
					}

					// Signed in for the first time, it is turned on; a setting somebody chose stays.
					if (found.access === "off") {
						yield* connections
							.update(owner.workspaceId, owner.podId, owner.connectionId, { access: "allow" })
							.pipe(Effect.catchTag("ConnectionNameTaken", () => Effect.void));
					}
					yield* discoverQuietly(at);
					return { pod };
				}),
			),
	});
});

export const layerNoDeps = Layer.effect(Service, make);

export const layer = layerNoDeps.pipe(
	Layer.provide([ConnectionRepository.layer, ConnectionSignIn.layer]),
);

export class ConnectionNotFound
	extends Data.TaggedError("ConnectionNotFound")
	implements UserFacing
{
	get userMessage() {
		return UserMessage.of`No such connection`;
	}
}

/** The server or its authorization server would not start a sign-in; the logs say why. */
export class ConnectionOAuthStartFailed
	extends Data.TaggedError("ConnectionOAuthStartFailed")
	implements UserFacing
{
	get userMessage() {
		return UserMessage.of`Could not start signing in to that server`;
	}
}

export class ConnectionDoesNotUseOAuth
	extends Data.TaggedError("ConnectionDoesNotUseOAuth")
	implements UserFacing
{
	get userMessage() {
		return UserMessage.of`This connection uses a secret, not OAuth`;
	}
}

export class ConnectionNeededNoSignIn
	extends Data.TaggedError("ConnectionNeededNoSignIn")
	implements UserFacing
{
	get userMessage() {
		return UserMessage.of`The server needed no sign-in`;
	}
}
