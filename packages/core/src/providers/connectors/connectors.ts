export * as Connectors from "./connectors.ts";

import type {
	Connector,
	ConnectorSignInOutcome,
	ConnectorTestResult,
	ConnectorUpdate,
	ConnectorWithTools,
	NewConnector,
	UnsavedConnector,
} from "@sugabots/contracts";
import {
	ConnectorDoesNotUseOAuth,
	type ConnectorNameTaken,
	ConnectorNeededNoSignIn,
	ConnectorNotFound,
	ConnectorOAuthStartFailed,
	type UnknownConnectorTool,
} from "@sugabots/contracts/errors/connectors";
import type { UrlNotAllowed } from "@sugabots/contracts/errors/providers";
import { Clock, Context, Effect, Layer } from "effect";
import { type Database, serviceOperations } from "../../database/database.ts";
import type { CanManageProject, CanReadConnectors } from "../../proofs/project-permissions.ts";
import type { ReachesProject } from "../../proofs/reaches-project.ts";
import { Secrets } from "../../secrets/secrets.ts";
import { processLayer, Tier } from "../../tiers.ts";
import { Egress, type EgressHttpClient } from "../network/egress.ts";
import { requireAllowedUrl } from "../tested-configuration.ts";
import { connectorIn, connectorsIn } from "./connector-reads.ts";
import { ConnectorSignIn } from "./connector-sign-in.ts";
import { ConnectorStore } from "./connector-store.ts";
import type { ConnectorTarget } from "./connector-target.ts";
import { listServerTools } from "./mcp.ts";
import { signInStartFailure } from "./oauth.ts";

/**
 * Connecting a project to MCP servers and HTTP endpoints, for operations that
 * have proved what each call needs: checking an address against the egress
 * policy before it is stored, learning a server's tools, and signing in to
 * one through its own OAuth. Each method takes the workspace and the project
 * from its proof, and the connector it names only from that project; a
 * bot's connectors are its default project's.
 */
export interface Interface {
	/** The project's connectors, oldest first. */
	readonly list: <P, J>(canRead: CanReadConnectors<P, J>) => Effect.Effect<Connector[]>;
	readonly get: <P, J>(
		canRead: CanReadConnectors<P, J>,
		connectorId: string,
	) => Effect.Effect<ConnectorWithTools, ConnectorNotFound>;
	/** Learns a server's tools straight away, unless it waits on a sign-in. */
	readonly create: <P, J>(
		canManage: CanManageProject<P, J>,
		connector: NewConnector,
	) => Effect.Effect<Connector, UrlNotAllowed | ConnectorNameTaken | ConnectorNotFound>;
	/** Asks the server at `server.url`, with its secret, for its tools, saving nothing. */
	readonly testUnsaved: <P, J>(
		canManage: CanManageProject<P, J>,
		server: UnsavedConnector,
	) => Effect.Effect<ConnectorTestResult, UrlNotAllowed>;
	/** A new address or secret sends the connector back to learn its tools. */
	readonly update: <P, J>(
		canManage: CanManageProject<P, J>,
		connectorId: string,
		changes: ConnectorUpdate,
	) => Effect.Effect<
		Connector,
		ConnectorNotFound | UrlNotAllowed | ConnectorNameTaken | UnknownConnectorTool
	>;
	readonly remove: <P, J>(
		canManage: CanManageProject<P, J>,
		connectorId: string,
	) => Effect.Effect<void, ConnectorNotFound>;
	/**
	 * Asks the server for its tools, or checks an HTTP endpoint's address
	 * without sending it anything, and records the outcome against the
	 * configuration tested.
	 */
	readonly test: <P, J>(
		canManage: CanManageProject<P, J>,
		connectorId: string,
	) => Effect.Effect<ConnectorTestResult, ConnectorNotFound>;
	/**
	 * Adds a built-in connector, which signs in with OAuth, and starts its
	 * sign-in as the member who manages the project. Keeps nothing when the
	 * sign-in can't start, or isn't needed.
	 */
	readonly connectBuiltIn: <P, J>(
		canManage: CanManageProject<P, J>,
		server: { name: string; url: string },
	) => Effect.Effect<
		{ connectorId: string; authorizationUrl: string },
		UrlNotAllowed | ConnectorNameTaken | ConnectorOAuthStartFailed | ConnectorNeededNoSignIn
	>;
	/**
	 * Where to send the browser to sign in, as the member who manages the
	 * project, or `null` when the server is already signed in to.
	 */
	readonly startSignIn: <P, J>(
		canManage: CanManageProject<P, J>,
		connectorId: string,
	) => Effect.Effect<
		{ authorizationUrl: string | null },
		ConnectorNotFound | ConnectorDoesNotUseOAuth | ConnectorOAuthStartFailed
	>;
	/**
	 * The sign-in a callback's `state` belongs to, for the operation to name
	 * its project and prove who may finish it. The state is the sign-in's own
	 * secret, handed only to the browser that started it, so finding it proves
	 * nothing; `finishSignIn` demands the proof.
	 */
	readonly signInWaitingOn: (state: string) => Effect.Effect<SignInUnderWay | undefined>;
	/**
	 * Finishes `signIn` with what the authorization server sent back, only
	 * for the member who started it, as the member whose management of the
	 * project was proved when they came back: authority can be withdrawn while
	 * they are away at the authorization server.
	 */
	readonly finishSignIn: <P, J>(
		canManage: CanManageProject<P, J>,
		signIn: SignInUnderWay,
		callback: SignInCallback,
	) => Effect.Effect<ConnectorSignInOutcome, ConnectorNotFound>;
}

export class Service extends Context.Service<Service, Interface>()("@sugabots/core/Connectors") {
	declare readonly [Tier]: "process";
}

/** A connector's sign-in waiting on its callback: its project and connector, and who started it. */
export interface SignInUnderWay {
	readonly projectId: string;
	readonly connectorId: string;
	readonly startedByMemberId: string | undefined;
}

/** What an authorization server sent the browser back with. */
export interface SignInCallback {
	readonly code?: string | undefined;
	readonly state: string;
	readonly error?: string | undefined;
	readonly errorDescription?: string | undefined;
}

/** One of a project's connectors, by its workspace, its project and its own id. */
interface ConnectorLocation {
	readonly workspaceId: string;
	readonly projectId: string;
	readonly connectorId: string;
}

/** The connector `connectorId` of the project `reach` proved reached. */
const locationIn = <P, J>(reach: ReachesProject<P, J>, connectorId: string): ConnectorLocation => ({
	workspaceId: reach.workspace,
	projectId: reach.project.value,
	connectorId,
});

export const make = Effect.gen(function* () {
	const operation = yield* serviceOperations<Interface>("Connectors");
	const connectors = yield* ConnectorStore.Service;
	const signIn = yield* ConnectorSignIn.Service;
	const egress = yield* Egress.Service;
	const cipher = yield* Secrets.Service;

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
			// It answers every failure as one, rather than rejecting.
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
		list: (canRead) =>
			operation("list", connectorsIn(canRead.reach.workspace, canRead.reach.project.value, cipher)),

		get: (canRead, connectorId) =>
			operation("get", requireConnector(locationIn(canRead.reach, connectorId))),

		create: (canManage, connector) =>
			operation(
				"create",
				Effect.gen(function* () {
					const { reach, member } = canManage;
					yield* requireAllowedUrl(egress, connector.url);
					const made = yield* connectors.create(
						reach.workspace,
						reach.project.value,
						member.actor.memberId,
						connector,
					);
					const at = locationIn(reach, made.id);
					if (connector.kind === "http" || connector.auth !== "oauth") {
						yield* discoverQuietly(at);
					}
					return yield* requireConnector(at);
				}),
			),

		testUnsaved: (_canManage, server) =>
			operation(
				"testUnsaved",
				Effect.gen(function* () {
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

		update: (canManage, connectorId, changes) =>
			operation(
				"update",
				Effect.gen(function* () {
					const at = locationIn(canManage.reach, connectorId);
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
					if (ConnectorStore.changesReach(changes)) yield* discoverQuietly(at);
					return yield* requireConnector(at);
				}),
			),

		remove: (canManage, connectorId) =>
			operation(
				"remove",
				Effect.gen(function* () {
					const at = locationIn(canManage.reach, connectorId);
					if (!(yield* connectors.remove(at.workspaceId, at.projectId, at.connectorId))) {
						return yield* new ConnectorNotFound();
					}
				}),
			),

		test: (canManage, connectorId) =>
			operation("test", test(locationIn(canManage.reach, connectorId))),

		connectBuiltIn: (canManage, server) =>
			operation(
				"connectBuiltIn",
				Effect.gen(function* () {
					const { reach, member } = canManage;
					const workspaceId = reach.workspace;
					const projectId = reach.project.value;
					yield* requireAllowedUrl(egress, server.url);
					const made = yield* connectors.create(workspaceId, projectId, member.actor.memberId, {
						...server,
						auth: "oauth",
					});
					const started = yield* startSignIn({
						workspaceId,
						connectorId: made.id,
						serverUrl: made.url,
						startedByMemberId: member.actor.memberId,
					}).pipe(Effect.tapError(() => connectors.remove(workspaceId, projectId, made.id)));
					if ("authorized" in started) {
						// Nothing to sign in to, so nothing the member asked for was made.
						yield* connectors.remove(workspaceId, projectId, made.id);
						return yield* new ConnectorNeededNoSignIn();
					}
					return { connectorId: made.id, authorizationUrl: started.authorizationUrl };
				}),
			),

		startSignIn: (canManage, connectorId) =>
			operation(
				"startSignIn",
				Effect.gen(function* () {
					const at = locationIn(canManage.reach, connectorId);
					const found = yield* requireConnector(at);
					if (found.auth !== "oauth") {
						return yield* new ConnectorDoesNotUseOAuth();
					}
					const started = yield* startSignIn({
						workspaceId: at.workspaceId,
						connectorId: at.connectorId,
						serverUrl: found.url,
						startedByMemberId: canManage.member.actor.memberId,
					});
					if ("authorized" in started) {
						yield* discoverQuietly(at);
						return { authorizationUrl: null };
					}
					return { authorizationUrl: started.authorizationUrl };
				}),
			),

		signInWaitingOn: (state) =>
			operation(
				"signInWaitingOn",
				Effect.map(
					connectors.byOauthState(state),
					(found): SignInUnderWay | undefined =>
						found && {
							projectId: found.projectId,
							connectorId: found.connectorId,
							startedByMemberId: found.startedByMemberId,
						},
				),
			),

		finishSignIn: (canManage, waiting, callback) =>
			operation(
				"finishSignIn",
				Effect.gen(function* (): Effect.fn.Return<
					ConnectorSignInOutcome,
					ConnectorNotFound,
					Database
				> {
					const { reach, member } = canManage;
					const memberId = member.actor.memberId;
					// Somebody else's browser bringing the callback would otherwise store
					// the credential they signed in with on a connector they never chose.
					if (waiting.startedByMemberId !== memberId) {
						return { kind: "failed", failure: "not_allowed", at: undefined };
					}
					const project = { workspaceId: reach.workspace, projectId: reach.project.value };
					if (callback.error || !callback.code) {
						yield* Effect.logWarning("An authorization server refused a connector's sign-in", {
							error: callback.error,
							description: callback.errorDescription,
						});
						return { kind: "failed", failure: "refused", at: project };
					}
					const at = locationIn(reach, waiting.connectorId);
					const found = yield* requireConnector(at);
					const finished = yield* Effect.result(
						signIn.finish(
							at.workspaceId,
							at.connectorId,
							found.url,
							{ code: callback.code, state: callback.state },
							memberId,
						),
					);
					if (finished._tag === "Failure") {
						yield* Effect.logWarning("A connector's sign-in did not finish", finished.failure);
						return { kind: "failed", failure: "not_completed", at: project };
					}

					yield* discoverQuietly(at);
					return { kind: "done", at: project };
				}),
			),
	});
});

export const layerNoDeps = processLayer(Layer.effect(Service, make));

export const layer = layerNoDeps.pipe(Layer.provide([ConnectorStore.layer, ConnectorSignIn.layer]));
