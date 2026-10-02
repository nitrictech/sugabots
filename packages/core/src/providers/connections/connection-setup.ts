export * as ConnectionSetup from "./connection-setup.ts";

import type {
	Connection,
	ConnectionSignInFailure,
	ConnectionTestResult,
	ConnectionUpdate,
	NewConnection,
} from "@sugabots/contracts";
import { Clock, Context, Data, Effect, Layer } from "effect";
import type { AuthorizationDenied } from "../../authorization/access.ts";
import { Authorization } from "../../authorization/authorization.ts";
import { CurrentActor } from "../../authorization/current-actor.ts";
import type { PodPermission } from "../../authorization/permissions.ts";
import { Credentials } from "../../credentials/credentials.ts";
import { serviceOperations } from "../../database/database.ts";
import { type UserFacing, UserMessage } from "../../user-message.ts";
import { Egress } from "../network/egress.ts";
import { requireAllowedUrl, type UrlNotAllowed } from "../tested-configuration.ts";
import { connectionIn, connectionsIn, toConnection } from "./connection-reads.ts";
import { ConnectionRepository } from "./connection-repository.ts";
import { ConnectionSignIn } from "./connection-sign-in.ts";
import { listServerTools } from "./mcp.ts";
import { type SignInStartFailure, signInStartFailure } from "./oauth.ts";

/**
 * Connecting a pod to MCP servers: checking an address against the egress
 * policy before it is stored, learning a server's tools, and signing in to one
 * through its own OAuth. Seeing a pod's connections takes the current actor's
 * `connection.read` there, and changing them `connection.manage`.
 */
export interface Interface {
	readonly list: (
		pod: InPod,
	) => Effect.Effect<Connection[], AuthorizationDenied, CurrentActor.Service>;
	readonly get: (
		input: InConnection,
	) => Effect.Effect<Connection, AuthorizationDenied | ConnectionNotFound, CurrentActor.Service>;
	/** Learns a server's tools straight away, unless it waits on a sign-in. */
	readonly create: (
		input: InPod & { connection: NewConnection },
	) => Effect.Effect<
		Connection,
		| AuthorizationDenied
		| UrlNotAllowed
		| ConnectionRepository.ConnectionNameTaken
		| ConnectionNotFound,
		CurrentActor.Service
	>;
	/** A new address or secret sends the connection back to learn its tools. */
	readonly update: (
		input: InConnection & { changes: ConnectionUpdate },
	) => Effect.Effect<
		Connection,
		| AuthorizationDenied
		| ConnectionNotFound
		| UrlNotAllowed
		| ConnectionRepository.ConnectionNameTaken,
		CurrentActor.Service
	>;
	readonly remove: (
		input: InConnection,
	) => Effect.Effect<void, AuthorizationDenied | ConnectionNotFound, CurrentActor.Service>;
	/** Asks the server for its tools, and records what it said against the configuration asked. */
	readonly test: (
		input: InConnection,
	) => Effect.Effect<
		ConnectionTestResult,
		AuthorizationDenied | ConnectionNotFound,
		CurrentActor.Service
	>;
	/** Adds a catalogued server, which signs in with OAuth, and starts its sign-in. */
	readonly connectFromCatalog: (
		input: InPod & { server: { name: string; url: string } },
	) => Effect.Effect<
		{ connectionId: string; authorizationUrl: string },
		| AuthorizationDenied
		| UrlNotAllowed
		| ConnectionRepository.ConnectionNameTaken
		| ConnectionOAuthStartFailed
		| ConnectionNeededNoSignIn,
		CurrentActor.Service
	>;
	/** Where to send the browser to sign in, or `null` when the server is already signed in to. */
	readonly startOAuth: (
		input: InConnection,
	) => Effect.Effect<
		{ authorizationUrl: string | null },
		| AuthorizationDenied
		| ConnectionNotFound
		| ConnectionDoesNotUseOAuth
		| ConnectionOAuthStartFailed,
		CurrentActor.Service
	>;
	/**
	 * Finishes a sign-in with what the authorization server sent back, only for
	 * the actor who started it and only while they may still manage the pod's
	 * connections.
	 */
	readonly completeOAuth: (input: {
		callback: { code?: string; state?: string; error?: string; errorDescription?: string };
	}) => Effect.Effect<SignInOutcome, ConnectionNotFound, CurrentActor.Service>;
}

export interface InPod {
	podId: string;
}

/** One of a pod's connections. */
export interface InConnection extends InPod {
	connectionId: string;
}

/** A pod, by its workspace and its own id. */
export interface PodLocation {
	workspaceId: string;
	podId: string;
}

/** One of a pod's connections, by its workspace, its pod and its own id. */
interface ConnectionLocation extends PodLocation {
	connectionId: string;
}

/**
 * How a sign-in ended. `pod` is there once the sign-in is known to be for a
 * pod the caller manages, so the browser can be sent back to it.
 */
export type SignInOutcome =
	| { pod: PodLocation }
	| { failure: ConnectionSignInFailure; pod?: PodLocation };

export class Service extends Context.Service<Service, Interface>()(
	"@sugabots/core/ConnectionSetup",
) {}

export const make = Effect.gen(function* () {
	const operation = yield* serviceOperations<Interface>("ConnectionSetup");
	const authorization = yield* Authorization.Service;
	const connections = yield* ConnectionRepository.Service;
	const signIn = yield* ConnectionSignIn.Service;
	const egress = yield* Egress.Service;
	const cipher = yield* Credentials.Service;

	/** Where the connection is, once the actor may take `permission` in its pod. */
	const locate = ({ podId, connectionId }: InConnection, permission: PodPermission) =>
		Effect.map(
			authorization.pod(podId, permission),
			({ pod }): ConnectionLocation => ({
				workspaceId: pod.workspaceId,
				podId: pod.id,
				connectionId,
			}),
		);

	const requireConnection = ({ workspaceId, podId, connectionId }: ConnectionLocation) =>
		Effect.filterOrFail(
			connectionIn(workspaceId, podId, connectionId, cipher),
			(found) => found !== undefined,
			() => new ConnectionNotFound(),
		);

	const test = (at: ConnectionLocation) =>
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
	const discoverQuietly = (at: ConnectionLocation) =>
		test(at).pipe(
			Effect.asVoid,
			Effect.catchTag("ConnectionNotFound", () => Effect.void),
		);

	const startSignIn = (input: Parameters<ConnectionSignIn.Interface["begin"]>[0]) =>
		signIn.begin(input).pipe(
			Effect.tapError((failure) =>
				Effect.logWarning("A connection's sign-in did not start", failure),
			),
			Effect.mapError(
				(failure) => new ConnectionOAuthStartFailed({ reason: signInStartFailure(failure.cause) }),
			),
		);

	return Service.of({
		list: ({ podId }) =>
			operation(
				"list",
				Effect.flatMap(authorization.pod(podId, "connection.read"), ({ pod }) =>
					connectionsIn(pod.workspaceId, pod.id, cipher),
				),
			),

		get: (input) =>
			operation("get", Effect.flatMap(locate(input, "connection.read"), requireConnection)),

		create: ({ podId, connection }) =>
			operation(
				"create",
				Effect.gen(function* () {
					const { pod, actor } = yield* authorization.pod(podId, "connection.manage");
					yield* requireAllowedUrl(egress, connection.url);
					const made = yield* connections.create(pod.workspaceId, pod.id, actor.userId, connection);
					const at = { workspaceId: pod.workspaceId, podId: pod.id, connectionId: made.id };
					if (connection.auth !== "oauth") {
						yield* discoverQuietly(at);
					}
					return yield* requireConnection(at);
				}),
			),

		update: ({ changes, ...input }) =>
			operation(
				"update",
				Effect.gen(function* () {
					const at = yield* locate(input, "connection.manage");
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

		remove: (input) =>
			operation(
				"remove",
				Effect.gen(function* () {
					const at = yield* locate(input, "connection.manage");
					if (!(yield* connections.remove(at.workspaceId, at.podId, at.connectionId))) {
						return yield* new ConnectionNotFound();
					}
				}),
			),

		test: (input) => operation("test", Effect.flatMap(locate(input, "connection.manage"), test)),

		connectFromCatalog: ({ podId, server }) =>
			operation(
				"connectFromCatalog",
				Effect.gen(function* () {
					const { pod, actor } = yield* authorization.pod(podId, "connection.manage");
					const workspaceId = pod.workspaceId;
					yield* requireAllowedUrl(egress, server.url);
					const made = yield* connections.create(workspaceId, pod.id, actor.userId, {
						...server,
						auth: "oauth",
					});
					const started = yield* startSignIn({
						workspaceId,
						connectionId: made.id,
						serverUrl: made.url,
						startedByUserId: actor.userId,
					}).pipe(Effect.tapError(() => connections.remove(workspaceId, pod.id, made.id)));
					if ("authorized" in started) {
						// Nothing to sign in to, so nothing the person asked for was made.
						yield* connections.remove(workspaceId, pod.id, made.id);
						return yield* new ConnectionNeededNoSignIn();
					}
					return { connectionId: made.id, authorizationUrl: started.authorizationUrl };
				}),
			),

		startOAuth: (input) =>
			operation(
				"startOAuth",
				Effect.gen(function* () {
					const at = yield* locate(input, "connection.manage");
					const found = yield* requireConnection(at);
					if (found.auth !== "oauth") {
						return yield* new ConnectionDoesNotUseOAuth();
					}
					const { userId } = yield* CurrentActor.Service;
					const started = yield* startSignIn({
						workspaceId: at.workspaceId,
						connectionId: at.connectionId,
						serverUrl: found.url,
						startedByUserId: userId,
					});
					if ("authorized" in started) {
						yield* discoverQuietly(at);
						return { authorizationUrl: null };
					}
					return { authorizationUrl: started.authorizationUrl };
				}),
			),

		completeOAuth: ({ callback }) =>
			operation(
				"completeOAuth",
				Effect.gen(function* () {
					if (!callback.state) return { failure: "missing_state" as const };
					const owner = yield* connections.byOauthState(callback.state);
					if (!owner) return { failure: "unknown_state" as const };
					// Somebody else's browser bringing the callback would otherwise store
					// the credential they signed in with on a connection they never chose.
					const { userId } = yield* CurrentActor.Service;
					if (owner.startedByUserId !== userId) return { failure: "not_allowed" as const };
					// Asked again rather than carried over from the request that started
					// the sign-in: authority can be withdrawn while the person is away at
					// the authorization server, and completing would store a credential
					// they may no longer manage.
					const allowed = yield* Effect.result(authorization.pod(owner.podId, "connection.manage"));
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
	Layer.provide([Authorization.layer, ConnectionRepository.layer, ConnectionSignIn.layer]),
);

export class ConnectionNotFound
	extends Data.TaggedError("ConnectionNotFound")
	implements UserFacing
{
	get userMessage() {
		return UserMessage.of`No such connection`;
	}
}

/**
 * The server or its authorization server would not start a sign-in. `reason`
 * is why, as far as it is known; the logs have the full cause.
 */
export class ConnectionOAuthStartFailed
	extends Data.TaggedError("ConnectionOAuthStartFailed")<{ readonly reason: SignInStartFailure }>
	implements UserFacing
{
	get userMessage() {
		if (this.reason === "registration_unsupported") {
			return UserMessage.of`Sugabots can't use this server's sign-in, because the server doesn't let new apps register themselves. Connect it with an access token from the server instead.`;
		}
		if (this.reason === "unreachable") {
			return UserMessage.of`Sugabots couldn't reach the server to start signing in. Check the address and that the server is running, then try again.`;
		}
		return UserMessage.of`The server didn't start a sign-in. Try again, or connect it with an access token from the server instead.`;
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
		return UserMessage.of`This server doesn't need a sign-in, so nothing was added. Connect it without one instead.`;
	}
}
