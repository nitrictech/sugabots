export * as ConnectionSetup from "./connection-setup.ts";

import type {
	Connection,
	ConnectionSignInFailure,
	ConnectionTestResult,
	ConnectionUpdate,
	ConnectionWithTools,
	NewConnection,
	UnsavedConnection,
} from "@sugabots/contracts";
import { userText } from "@sugabots/errors";
import { Clock, Context, Data, Effect, Layer } from "effect";
import type { AuthorizationDenied } from "../../authorization/access.ts";
import { Authorization } from "../../authorization/authorization.ts";
import { CurrentActor } from "../../authorization/current-actor.ts";
import type { AgentPermission } from "../../authorization/permissions.ts";
import { Credentials } from "../../credentials/credentials.ts";
import { serviceOperations } from "../../database/database.ts";
import type { UserFacing } from "../../user-message.ts";
import { Egress, type EgressHttpClient } from "../network/egress.ts";
import { requireAllowedUrl, type UrlNotAllowed } from "../tested-configuration.ts";
import { connectionIn, connectionsIn } from "./connection-reads.ts";
import { ConnectionRepository } from "./connection-repository.ts";
import { ConnectionSignIn } from "./connection-sign-in.ts";
import type { ConnectionTarget } from "./connection-target.ts";
import { listServerTools } from "./mcp.ts";
import { type SignInStartFailure, signInStartFailure } from "./oauth.ts";

/**
 * Connecting a bot to MCP servers: checking an address against the egress
 * policy before it is stored, learning a server's tools, and signing in to one
 * through its own OAuth. Seeing a bot's connections takes the current actor's
 * `connection.read` on it, and changing them `connection.manage`.
 */
export interface Interface {
	readonly list: (
		agent: InAgent,
	) => Effect.Effect<Connection[], AuthorizationDenied, CurrentActor.Service>;
	readonly get: (
		input: InConnection,
	) => Effect.Effect<
		ConnectionWithTools,
		AuthorizationDenied | ConnectionNotFound,
		CurrentActor.Service
	>;
	/** Learns a server's tools straight away, unless it waits on a sign-in. */
	readonly create: (
		input: InAgent & { connection: NewConnection },
	) => Effect.Effect<
		Connection,
		| AuthorizationDenied
		| UrlNotAllowed
		| ConnectionRepository.ConnectionNameTaken
		| ConnectionNotFound,
		CurrentActor.Service
	>;
	/** testUnsaved asks the server at `server.url`, with its secret, for its tools, saving nothing. */
	readonly testUnsaved: (
		input: InAgent & { server: UnsavedConnection },
	) => Effect.Effect<
		ConnectionTestResult,
		AuthorizationDenied | UrlNotAllowed,
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
		| ConnectionRepository.ConnectionNameTaken
		| ConnectionRepository.UnknownConnectionTool,
		CurrentActor.Service
	>;
	readonly remove: (
		input: InConnection,
	) => Effect.Effect<void, AuthorizationDenied | ConnectionNotFound, CurrentActor.Service>;
	/**
	 * Asks the server for its tools, or checks an HTTP endpoint's address
	 * without sending it anything, and records the outcome against the
	 * configuration tested.
	 */
	readonly test: (
		input: InConnection,
	) => Effect.Effect<
		ConnectionTestResult,
		AuthorizationDenied | ConnectionNotFound,
		CurrentActor.Service
	>;
	/** Adds a catalogued server, which signs in with OAuth, and starts its sign-in. */
	readonly connectFromCatalog: (
		input: InAgent & { server: { name: string; url: string } },
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
	 * the actor who started it and only while they may still manage the bot's
	 * connections.
	 */
	readonly completeOAuth: (input: {
		callback: { code?: string; state?: string; error?: string; errorDescription?: string };
	}) => Effect.Effect<SignInOutcome, ConnectionNotFound, CurrentActor.Service>;
}

export interface InAgent {
	agentId: string;
}

/** One of a bot's connections. */
export interface InConnection extends InAgent {
	connectionId: string;
}

/** A bot, by its workspace and its own id. */
export interface AgentLocation {
	workspaceId: string;
	agentId: string;
}

/** One of a bot's connections, by its workspace, its bot and its own id. */
interface ConnectionLocation extends AgentLocation {
	connectionId: string;
}

/**
 * How a sign-in ended. `agent` is there once the sign-in is known to be for a
 * bot the caller manages, so the browser can be sent back to it.
 */
export type SignInOutcome =
	| { agent: AgentLocation }
	| { failure: ConnectionSignInFailure; agent?: AgentLocation };

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

	/** Where the connection is, once the actor may take `permission` on its bot. */
	const locate = ({ agentId, connectionId }: InConnection, permission: AgentPermission) =>
		Effect.map(
			authorization.agent(agentId, permission),
			({ agent }): ConnectionLocation => ({
				workspaceId: agent.workspaceId,
				agentId: agent.id,
				connectionId,
			}),
		);

	const requireConnection = ({ workspaceId, agentId, connectionId }: ConnectionLocation) =>
		Effect.filterOrFail(
			connectionIn(workspaceId, agentId, connectionId, cipher),
			(found) => found !== undefined,
			() => new ConnectionNotFound(),
		);

	const test = (at: ConnectionLocation) =>
		Effect.gen(function* () {
			const target = yield* connections.target(at.workspaceId, at.agentId, at.connectionId);
			if (!target) {
				return yield* new ConnectionNotFound();
			}
			if (target.kind === "http") {
				return yield* checkEndpoint(at, target);
			}
			const clients = yield* signIn.clients;
			const { found, result } = yield* askServer(
				{
					url: target.url,
					headers: target.headers,
					authProvider:
						target.auth === "oauth" ? clients.for(at.workspaceId, at.connectionId) : undefined,
				},
				target.auth === "oauth" ? egress.oauth : egress.providers.for({ baseUrl: target.url }),
			);
			yield* connections.recordTest(
				at.workspaceId,
				at.connectionId,
				target.configurationUpdatedAt,
				found.ok ? { tools: found.tools } : { error: found.reason },
			);
			return result;
		});

	/**
	 * An HTTP endpoint's tools are Sugabots' own, so there is nothing to ask
	 * it: a request to it would be one a bot never chose. Its address is
	 * checked against the egress policy again, which may have changed since
	 * it was saved.
	 */
	const checkEndpoint = (at: ConnectionLocation, target: ConnectionTarget) =>
		Effect.gen(function* () {
			const checked = yield* Effect.result(egress.validateProviderUrl(target.url));
			const error = checked._tag === "Failure" ? checked.failure.userMessage : undefined;
			yield* connections.recordTest(
				at.workspaceId,
				at.connectionId,
				target.configurationUpdatedAt,
				error ? { error } : {},
			);
			const result: ConnectionTestResult = {
				reachable: error === undefined,
				latencyMs: 0,
				...(error && { error }),
			};
			return result;
		});

	/** askServer lists the tools of `server` through `fetch`, timing it, and logs why it failed when it does. */
	const askServer = (server: Parameters<typeof listServerTools>[0], fetch: EgressHttpClient) =>
		Effect.gen(function* () {
			const started = yield* Clock.currentTimeMillis;
			const found = yield* Effect.promise(() => listServerTools(server, fetch));
			const latencyMs = (yield* Clock.currentTimeMillis) - started;
			if (!found.ok) {
				yield* Effect.logWarning("Asking a connection's server for its tools failed", found.cause);
			}
			const result: ConnectionTestResult = {
				reachable: found.ok,
				latencyMs,
				...(found.ok ? { tools: found.tools.length } : { error: found.reason }),
			};
			return { found, result };
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
		list: ({ agentId }) =>
			operation(
				"list",
				Effect.flatMap(authorization.agent(agentId, "connection.read"), ({ agent }) =>
					connectionsIn(agent.workspaceId, agent.id, cipher),
				),
			),

		get: (input) =>
			operation("get", Effect.flatMap(locate(input, "connection.read"), requireConnection)),

		create: ({ agentId, connection }) =>
			operation(
				"create",
				Effect.gen(function* () {
					const { agent, actor } = yield* authorization.agent(agentId, "connection.manage");
					yield* requireAllowedUrl(egress, connection.url);
					const made = yield* connections.create(
						agent.workspaceId,
						agent.id,
						actor.userId,
						connection,
					);
					const at = { workspaceId: agent.workspaceId, agentId: agent.id, connectionId: made.id };
					if (connection.kind === "http" || connection.auth !== "oauth") {
						yield* discoverQuietly(at);
					}
					return yield* requireConnection(at);
				}),
			),

		testUnsaved: ({ agentId, server }) =>
			operation(
				"testUnsaved",
				Effect.gen(function* () {
					yield* authorization.agent(agentId, "connection.manage");
					yield* requireAllowedUrl(egress, server.url);
					const headers: Record<string, string> =
						server.secretHeader && server.secret ? { [server.secretHeader]: server.secret } : {};
					const { result } = yield* askServer(
						{ url: server.url, headers },
						egress.providers.for({ baseUrl: server.url }),
					);
					return result;
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
						at.agentId,
						at.connectionId,
						changes,
					);
					if (!updated) {
						return yield* new ConnectionNotFound();
					}
					if (
						changes.url !== undefined ||
						changes.secret !== undefined ||
						changes.secretHeader !== undefined
					) {
						yield* discoverQuietly(at);
					}
					return yield* requireConnection(at);
				}),
			),

		remove: (input) =>
			operation(
				"remove",
				Effect.gen(function* () {
					const at = yield* locate(input, "connection.manage");
					if (!(yield* connections.remove(at.workspaceId, at.agentId, at.connectionId))) {
						return yield* new ConnectionNotFound();
					}
				}),
			),

		test: (input) => operation("test", Effect.flatMap(locate(input, "connection.manage"), test)),

		connectFromCatalog: ({ agentId, server }) =>
			operation(
				"connectFromCatalog",
				Effect.gen(function* () {
					const { agent, actor } = yield* authorization.agent(agentId, "connection.manage");
					const workspaceId = agent.workspaceId;
					yield* requireAllowedUrl(egress, server.url);
					const made = yield* connections.create(workspaceId, agent.id, actor.userId, {
						...server,
						auth: "oauth",
					});
					const started = yield* startSignIn({
						workspaceId,
						connectionId: made.id,
						serverUrl: made.url,
						startedByUserId: actor.userId,
					}).pipe(Effect.tapError(() => connections.remove(workspaceId, agent.id, made.id)));
					if ("authorized" in started) {
						// Nothing to sign in to, so nothing the person asked for was made.
						yield* connections.remove(workspaceId, agent.id, made.id);
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
					const allowed = yield* Effect.result(
						authorization.agent(owner.agentId, "connection.manage"),
					);
					if (allowed._tag === "Failure") return { failure: "not_allowed" as const };

					const agent = { workspaceId: owner.workspaceId, agentId: owner.agentId };
					if (callback.error || !callback.code) {
						yield* Effect.logWarning("An authorization server refused a connection's sign-in", {
							error: callback.error,
							description: callback.errorDescription,
						});
						return { failure: "refused" as const, agent };
					}
					const at = { ...agent, connectionId: owner.connectionId };
					const found = yield* requireConnection(at);
					const finished = yield* Effect.result(
						signIn.finish(owner.workspaceId, owner.connectionId, found.url, {
							code: callback.code,
							state: callback.state,
						}),
					);
					if (finished._tag === "Failure") {
						yield* Effect.logWarning("A connection's sign-in did not finish", finished.failure);
						return { failure: "not_completed" as const, agent };
					}

					yield* discoverQuietly(at);
					return { agent };
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
		return userText`No such connection`;
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
			return userText`Sugabots can't use this server's sign-in, because the server doesn't let new apps register themselves. Connect it with an access token from the server instead.`;
		}
		if (this.reason === "unreachable") {
			return userText`Sugabots couldn't reach the server to start signing in. Check the address and that the server is running, then try again.`;
		}
		return userText`The server didn't start a sign-in. Try again, or connect it with an access token from the server instead.`;
	}
}

export class ConnectionDoesNotUseOAuth
	extends Data.TaggedError("ConnectionDoesNotUseOAuth")
	implements UserFacing
{
	get userMessage() {
		return userText`This connection uses a secret, not OAuth`;
	}
}

export class ConnectionNeededNoSignIn
	extends Data.TaggedError("ConnectionNeededNoSignIn")
	implements UserFacing
{
	get userMessage() {
		return userText`This server doesn't need a sign-in, so nothing was added. Connect it without one instead.`;
	}
}
