export * as ConnectorSetup from "./connector-setup.ts";

import type {
	Connector,
	ConnectorSignInFailure,
	ConnectorTestResult,
	ConnectorUpdate,
	ConnectorWithTools,
	NewConnector,
	UnsavedConnector,
} from "@sugabots/contracts";
import { userText } from "@sugabots/errors";
import { Clock, Context, Data, Effect, Layer } from "effect";
import type { AuthorizationDenied } from "../../authorization/access.ts";
import { Authorization } from "../../authorization/authorization.ts";
import { CurrentActor } from "../../authorization/current-actor.ts";
import type { ProjectPermission } from "../../authorization/permissions.ts";
import { serviceOperations } from "../../database/database.ts";
import { Secrets } from "../../secrets/secrets.ts";
import type { UserFacing } from "../../user-message.ts";
import { Egress, type EgressHttpClient } from "../network/egress.ts";
import { requireAllowedUrl, type UrlNotAllowed } from "../tested-configuration.ts";
import { connectorIn, connectorsIn } from "./connector-reads.ts";
import { ConnectorSignIn } from "./connector-sign-in.ts";
import { ConnectorStore } from "./connector-store.ts";
import type { ConnectorTarget } from "./connector-target.ts";
import { listServerTools } from "./mcp.ts";
import { type SignInStartFailure, signInStartFailure } from "./oauth.ts";

/**
 * Connecting a project to MCP servers and HTTP endpoints: checking an address
 * against the egress policy before it is stored, learning a server's tools,
 * and signing in to one through its own OAuth. Seeing a project's connectors
 * takes the current actor's `connector.read` in it, and changing them
 * `connector.manage`; a bot's are its default project's.
 */
export interface Interface {
	readonly list: (
		project: InProject,
	) => Effect.Effect<Connector[], AuthorizationDenied, CurrentActor.Service>;
	readonly get: (
		input: InConnector,
	) => Effect.Effect<
		ConnectorWithTools,
		AuthorizationDenied | ConnectorNotFound,
		CurrentActor.Service
	>;
	/** Learns a server's tools straight away, unless it waits on a sign-in. */
	readonly create: (
		input: InProject & { connector: NewConnector },
	) => Effect.Effect<
		Connector,
		AuthorizationDenied | UrlNotAllowed | ConnectorStore.ConnectorNameTaken | ConnectorNotFound,
		CurrentActor.Service
	>;
	/** testUnsaved asks the server at `server.url`, with its secret, for its tools, saving nothing. */
	readonly testUnsaved: (
		input: InProject & { server: UnsavedConnector },
	) => Effect.Effect<
		ConnectorTestResult,
		AuthorizationDenied | UrlNotAllowed,
		CurrentActor.Service
	>;
	/** A new address or secret sends the connector back to learn its tools. */
	readonly update: (
		input: InConnector & { changes: ConnectorUpdate },
	) => Effect.Effect<
		Connector,
		| AuthorizationDenied
		| ConnectorNotFound
		| UrlNotAllowed
		| ConnectorStore.ConnectorNameTaken
		| ConnectorStore.UnknownConnectorTool,
		CurrentActor.Service
	>;
	readonly remove: (
		input: InConnector,
	) => Effect.Effect<void, AuthorizationDenied | ConnectorNotFound, CurrentActor.Service>;
	/**
	 * Asks the server for its tools, or checks an HTTP endpoint's address
	 * without sending it anything, and records the outcome against the
	 * configuration tested.
	 */
	readonly test: (
		input: InConnector,
	) => Effect.Effect<
		ConnectorTestResult,
		AuthorizationDenied | ConnectorNotFound,
		CurrentActor.Service
	>;
	/** Adds a built-in connector, which signs in with OAuth, and starts its sign-in. */
	readonly connectBuiltIn: (
		input: InProject & { server: { name: string; url: string } },
	) => Effect.Effect<
		{ connectorId: string; authorizationUrl: string },
		| AuthorizationDenied
		| UrlNotAllowed
		| ConnectorStore.ConnectorNameTaken
		| ConnectorOAuthStartFailed
		| ConnectorNeededNoSignIn,
		CurrentActor.Service
	>;
	/** Where to send the browser to sign in, or `null` when the server is already signed in to. */
	readonly startOAuth: (
		input: InConnector,
	) => Effect.Effect<
		{ authorizationUrl: string | null },
		AuthorizationDenied | ConnectorNotFound | ConnectorDoesNotUseOAuth | ConnectorOAuthStartFailed,
		CurrentActor.Service
	>;
	/**
	 * Finishes a sign-in with what the authorization server sent back, only for
	 * the actor who started it and only while they may still manage the
	 * project's connectors.
	 */
	readonly completeOAuth: (input: {
		callback: { code?: string; state?: string; error?: string; errorDescription?: string };
	}) => Effect.Effect<SignInOutcome, ConnectorNotFound, CurrentActor.Service>;
}

interface InProject {
	projectId: string;
}

/** One of a project's connectors. */
interface InConnector extends InProject {
	connectorId: string;
}

/** A project, by its workspace and its own id. */
interface ProjectLocation {
	workspaceId: string;
	projectId: string;
}

/** One of a project's connectors, by its workspace, its project and its own id. */
interface ConnectorLocation extends ProjectLocation {
	connectorId: string;
}

/**
 * How a sign-in ended. `at` is there once the sign-in is known to be for a
 * project whose connectors the caller manages, so the browser can be sent
 * back to it.
 */
type SignInOutcome =
	| { at: ProjectLocation }
	| { failure: ConnectorSignInFailure; at?: ProjectLocation };

export class Service extends Context.Service<Service, Interface>()(
	"@sugabots/core/ConnectorSetup",
) {}

export const make = Effect.gen(function* () {
	const operation = yield* serviceOperations<Interface>("ConnectorSetup");
	const authorization = yield* Authorization.Service;
	const connectors = yield* ConnectorStore.Service;
	const signIn = yield* ConnectorSignIn.Service;
	const egress = yield* Egress.Service;
	const cipher = yield* Secrets.Service;

	/** Where the connector is, once the actor may take `permission` in its project. */
	const locate = ({ projectId, connectorId }: InConnector, permission: ProjectPermission) =>
		Effect.map(
			authorization.project(projectId, permission),
			({ project }): ConnectorLocation => ({
				workspaceId: project.workspaceId,
				projectId: project.id,
				connectorId,
			}),
		);

	const requireConnector = ({ workspaceId, projectId, connectorId }: ConnectorLocation) =>
		Effect.filterOrFail(
			connectorIn(workspaceId, projectId, connectorId, cipher),
			(found) => found !== undefined,
			() => new ConnectorNotFound(),
		);

	const test = (at: ConnectorLocation) =>
		Effect.gen(function* () {
			const target = yield* connectors.target(at.workspaceId, at.projectId, at.connectorId);
			if (!target) {
				return yield* new ConnectorNotFound();
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
						target.auth === "oauth" ? clients.for(at.workspaceId, at.connectorId) : undefined,
				},
				target.auth === "oauth" ? egress.oauth : egress.providers.for({ baseUrl: target.url }),
			);
			yield* connectors.recordTest(
				at.workspaceId,
				at.connectorId,
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
	const checkEndpoint = (at: ConnectorLocation, target: ConnectorTarget) =>
		Effect.gen(function* () {
			const checked = yield* Effect.result(egress.validateProviderUrl(target.url));
			const error = checked._tag === "Failure" ? checked.failure.userMessage : undefined;
			yield* connectors.recordTest(
				at.workspaceId,
				at.connectorId,
				target.configurationUpdatedAt,
				error ? { error } : {},
			);
			const result: ConnectorTestResult = {
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
				yield* Effect.logWarning("Asking a connector's server for its tools failed", found.cause);
			}
			const result: ConnectorTestResult = {
				reachable: found.ok,
				latencyMs,
				...(found.ok ? { tools: found.tools.length } : { error: found.reason }),
			};
			return { found, result };
		});

	/** A test whose outcome is recorded on the connector rather than returned. */
	const discoverQuietly = (at: ConnectorLocation) =>
		test(at).pipe(
			Effect.asVoid,
			Effect.catchTag("ConnectorNotFound", () => Effect.void),
		);

	const startSignIn = (input: Parameters<ConnectorSignIn.Interface["begin"]>[0]) =>
		signIn.begin(input).pipe(
			Effect.tapError((failure) =>
				Effect.logWarning("A connector's sign-in did not start", failure),
			),
			Effect.mapError(
				(failure) => new ConnectorOAuthStartFailed({ reason: signInStartFailure(failure.cause) }),
			),
		);

	return Service.of({
		list: ({ projectId }) =>
			operation(
				"list",
				Effect.flatMap(authorization.project(projectId, "connector.read"), ({ project }) =>
					connectorsIn(project.workspaceId, project.id, cipher),
				),
			),

		get: (input) =>
			operation("get", Effect.flatMap(locate(input, "connector.read"), requireConnector)),

		create: ({ projectId, connector }) =>
			operation(
				"create",
				Effect.gen(function* () {
					const { project, actor } = yield* authorization.project(projectId, "connector.manage");
					yield* requireAllowedUrl(egress, connector.url);
					const made = yield* connectors.create(
						project.workspaceId,
						project.id,
						actor.personId,
						connector,
					);
					const at = {
						workspaceId: project.workspaceId,
						projectId: project.id,
						connectorId: made.id,
					};
					if (connector.kind === "http" || connector.auth !== "oauth") {
						yield* discoverQuietly(at);
					}
					return yield* requireConnector(at);
				}),
			),

		testUnsaved: ({ projectId, server }) =>
			operation(
				"testUnsaved",
				Effect.gen(function* () {
					yield* authorization.project(projectId, "connector.manage");
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
					const at = yield* locate(input, "connector.manage");
					if (changes.url) {
						yield* requireAllowedUrl(egress, changes.url);
					}
					const updated = yield* connectors.update(
						at.workspaceId,
						at.projectId,
						at.connectorId,
						changes,
					);
					if (!updated) {
						return yield* new ConnectorNotFound();
					}
					if (
						changes.url !== undefined ||
						changes.secret !== undefined ||
						changes.secretHeader !== undefined
					) {
						yield* discoverQuietly(at);
					}
					return yield* requireConnector(at);
				}),
			),

		remove: (input) =>
			operation(
				"remove",
				Effect.gen(function* () {
					const at = yield* locate(input, "connector.manage");
					if (!(yield* connectors.remove(at.workspaceId, at.projectId, at.connectorId))) {
						return yield* new ConnectorNotFound();
					}
				}),
			),

		test: (input) => operation("test", Effect.flatMap(locate(input, "connector.manage"), test)),

		connectBuiltIn: ({ projectId, server }) =>
			operation(
				"connectBuiltIn",
				Effect.gen(function* () {
					const { project, actor } = yield* authorization.project(projectId, "connector.manage");
					const workspaceId = project.workspaceId;
					yield* requireAllowedUrl(egress, server.url);
					const made = yield* connectors.create(workspaceId, project.id, actor.personId, {
						...server,
						auth: "oauth",
					});
					const started = yield* startSignIn({
						workspaceId,
						connectorId: made.id,
						serverUrl: made.url,
						startedByPersonId: actor.personId,
					}).pipe(Effect.tapError(() => connectors.remove(workspaceId, project.id, made.id)));
					if ("authorized" in started) {
						// Nothing to sign in to, so nothing the person asked for was made.
						yield* connectors.remove(workspaceId, project.id, made.id);
						return yield* new ConnectorNeededNoSignIn();
					}
					return { connectorId: made.id, authorizationUrl: started.authorizationUrl };
				}),
			),

		startOAuth: (input) =>
			operation(
				"startOAuth",
				Effect.gen(function* () {
					const at = yield* locate(input, "connector.manage");
					const found = yield* requireConnector(at);
					if (found.auth !== "oauth") {
						return yield* new ConnectorDoesNotUseOAuth();
					}
					const { personId } = yield* CurrentActor.Service;
					const started = yield* startSignIn({
						workspaceId: at.workspaceId,
						connectorId: at.connectorId,
						serverUrl: found.url,
						startedByPersonId: personId,
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
					const owner = yield* connectors.byOauthState(callback.state);
					if (!owner) return { failure: "unknown_state" as const };
					// Somebody else's browser bringing the callback would otherwise store
					// the credential they signed in with on a connector they never chose.
					const { personId } = yield* CurrentActor.Service;
					if (owner.startedByPersonId !== personId) return { failure: "not_allowed" as const };
					// Asked again rather than carried over from the request that started
					// the sign-in: authority can be withdrawn while the person is away at
					// the authorization server, and completing would store a credential
					// they may no longer manage.
					const allowed = yield* Effect.result(
						authorization.project(owner.projectId, "connector.manage"),
					);
					if (allowed._tag === "Failure") return { failure: "not_allowed" as const };

					const project = { workspaceId: owner.workspaceId, projectId: owner.projectId };
					if (callback.error || !callback.code) {
						yield* Effect.logWarning("An authorization server refused a connector's sign-in", {
							error: callback.error,
							description: callback.errorDescription,
						});
						return { failure: "refused" as const, at: project };
					}
					const at = { ...project, connectorId: owner.connectorId };
					const found = yield* requireConnector(at);
					const finished = yield* Effect.result(
						signIn.finish(owner.workspaceId, owner.connectorId, found.url, {
							code: callback.code,
							state: callback.state,
						}),
					);
					if (finished._tag === "Failure") {
						yield* Effect.logWarning("A connector's sign-in did not finish", finished.failure);
						return { failure: "not_completed" as const, at: project };
					}

					yield* discoverQuietly(at);
					return { at: project };
				}),
			),
	});
});

export const layerNoDeps = Layer.effect(Service, make);

export const layer = layerNoDeps.pipe(
	Layer.provide([Authorization.layer, ConnectorStore.layer, ConnectorSignIn.layer]),
);

export class ConnectorNotFound extends Data.TaggedError("ConnectorNotFound") implements UserFacing {
	get userMessage() {
		return userText`No such connector`;
	}
}

/**
 * The server or its authorization server would not start a sign-in. `reason`
 * is why, as far as it is known; the logs have the full cause.
 */
export class ConnectorOAuthStartFailed
	extends Data.TaggedError("ConnectorOAuthStartFailed")<{ readonly reason: SignInStartFailure }>
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

export class ConnectorDoesNotUseOAuth
	extends Data.TaggedError("ConnectorDoesNotUseOAuth")
	implements UserFacing
{
	get userMessage() {
		return userText`This connector uses a secret, not OAuth`;
	}
}

export class ConnectorNeededNoSignIn
	extends Data.TaggedError("ConnectorNeededNoSignIn")
	implements UserFacing
{
	get userMessage() {
		return userText`This server doesn't need a sign-in, so nothing was added. Connect it without one instead.`;
	}
}
