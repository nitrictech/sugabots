export * as Connectors from "./connectors.ts";

import type {
	Connector,
	ConnectorSignInOutcome,
	ConnectorTestResult,
	ConnectorUpdate,
	ConnectorWithTools,
	NewConnector,
	ProjectBotConnector,
	RestrictableConnector,
	UnsavedConnector,
} from "@sugabots/contracts";
import {
	type ConnectorAddressChanged,
	ConnectorDoesNotUseOAuth,
	type ConnectorNameTaken,
	ConnectorNeededNoSignIn,
	ConnectorNotFound,
	ConnectorOAuthStartFailed,
	type UnknownConnectorTool,
} from "@sugabots/contracts/errors/connectors";
import { type ActionForbidden, ResourceHidden } from "@sugabots/contracts/errors/proofs";
import type { UrlNotAllowed } from "@sugabots/contracts/errors/providers";
import { Clock, Context, Effect, Layer } from "effect";
import { ProjectComputers } from "../../computers/project-computers.ts";
import { type Database, query, serviceOperations } from "../../database/database.ts";
import type { MemberSession } from "../../principal.ts";
import type { CanRestrictBotsProject } from "../../proofs/can-restrict-bot.ts";
import { mayInProjectAs, memberActing, memberReaches, reachFacts } from "../../proofs/facts.ts";
import { proveIsMember } from "../../proofs/is-member.ts";
import {
	type CanManageProject,
	type CanReadConnectors,
	memberManaging,
} from "../../proofs/project-permissions.ts";
import type { Named } from "../../proofs/proof.ts";
import type {
	CanSetProjectBotConnector,
	CanSwitchOffConnector,
	ReachesConnector,
} from "../../proofs/reaches-connector.ts";
import type { ReachesProject } from "../../proofs/reaches-project.ts";
import { Secrets } from "../../secrets/secrets.ts";
import { processLayer, Tier } from "../../tiers.ts";
import { Egress, type EgressHttpClient } from "../network/egress.ts";
import { requireAllowedUrl } from "../tested-configuration.ts";
import {
	connectorIn,
	connectorsIn,
	projectBotConnectorsIn,
	restrictableConnectorsIn,
} from "./connector-reads.ts";
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
	/** The own connectors of the project's bots, each with whether it is on in the project. */
	readonly listProjectBots: <P, J>(
		canRead: CanReadConnectors<P, J>,
	) => Effect.Effect<ProjectBotConnector[]>;
	/**
	 * Turns a project bot's own connector on in the project, for the address
	 * numbered `addressRevision`, which must still be its address, or off.
	 */
	readonly setOnInProject: <P, J, K>(
		canSet: CanSetProjectBotConnector<P, J, K>,
		change: { readonly on: boolean; readonly addressRevision?: number | undefined },
	) => Effect.Effect<ProjectBotConnector, ConnectorNotFound | ConnectorAddressChanged>;
	readonly listForRestriction: <P, J>(
		canRestrict: CanRestrictBotsProject<P, J>,
	) => Effect.Effect<RestrictableConnector[]>;
	readonly switchOff: <P, J, K>(
		canRestrict: CanRestrictBotsProject<P, J>,
		connector: Named<K, string>,
		target: CanSwitchOffConnector<P, J, K>,
	) => Effect.Effect<RestrictableConnector, ResourceHidden>;
	readonly get: <P, J, K>(
		canRead: CanReadConnectors<P, J>,
		connector: Named<K, string>,
		target: ReachesConnector<P, J, K>,
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
	readonly update: <P, J, K>(
		canManage: CanManageProject<P, J>,
		connector: Named<K, string>,
		target: ReachesConnector<P, J, K>,
		changes: ConnectorUpdate,
	) => Effect.Effect<
		Connector,
		ConnectorNotFound | UrlNotAllowed | ConnectorNameTaken | UnknownConnectorTool
	>;
	readonly remove: <P, J, K>(
		canManage: CanManageProject<P, J>,
		connector: Named<K, string>,
		target: ReachesConnector<P, J, K>,
	) => Effect.Effect<void, ConnectorNotFound>;
	/**
	 * Asks the server for its tools, or checks an HTTP endpoint's address
	 * without sending it anything, and records the outcome against the
	 * configuration tested.
	 */
	readonly test: <P, J, K>(
		canManage: CanManageProject<P, J>,
		connector: Named<K, string>,
		target: ReachesConnector<P, J, K>,
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
		| ActionForbidden
		| UrlNotAllowed
		| ConnectorNameTaken
		| ConnectorOAuthStartFailed
		| ConnectorNeededNoSignIn
	>;
	/**
	 * Where to send the browser to sign in, as the member who manages the
	 * project, or `null` when the server is already signed in to.
	 */
	readonly startSignIn: <P, J, K>(
		canManage: CanManageProject<P, J>,
		connector: Named<K, string>,
		target: ReachesConnector<P, J, K>,
	) => Effect.Effect<
		{ authorizationUrl: string | null },
		ActionForbidden | ConnectorNotFound | ConnectorDoesNotUseOAuth | ConnectorOAuthStartFailed
	>;
	/**
	 * The sign-in a callback's `state` belongs to, for the operation to name
	 * its project and prove who may finish it. The state is the sign-in's own
	 * secret, handed only to the browser that started it, so finding it proves
	 * nothing; `finishSignIn` demands the proof.
	 */
	readonly signInWaitingOn: (
		state: string,
		session: MemberSession,
	) => Effect.Effect<SignInUnderWay | undefined>;
	/**
	 * Finishes the sign-in for `connectorId` with what the authorization server sent back, only
	 * in the session that started it, as the member whose management of the
	 * project was proved when they came back: authority can be withdrawn while
	 * they are away at the authorization server.
	 */
	readonly finishSignIn: <P, J, K>(
		canManage: CanManageProject<P, J>,
		connector: Named<K, string>,
		target: ReachesConnector<P, J, K>,
		callback: SignInCallback,
	) => Effect.Effect<ConnectorSignInOutcome>;
}

export class Service extends Context.Service<Service, Interface>()("@sugabots/core/Connectors") {
	declare readonly [Tier]: "process";
}

/** A connector and its project waiting for the initiating session to finish signing in. */
interface SignInUnderWay {
	readonly projectId: string;
	readonly connectorId: string;
}

/** What an authorization server sent the browser back with. */
interface SignInCallback {
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
const locationIn = <J>(
	reach: { workspace: string; project: Named<J, string> },
	connectorId: string,
): ConnectorLocation => ({
	workspaceId: reach.workspace,
	projectId: reach.project.value,
	connectorId,
});

export const make = Effect.gen(function* () {
	const operation = yield* serviceOperations<Interface>("Connectors");
	const connectors = yield* ConnectorStore.Service;
	const computers = yield* ProjectComputers.Service;
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
					oauth:
						target.auth === "oauth"
							? clients.for(at.workspaceId, at.connectorId, target.url)
							: undefined,
				},
				target.auth === "oauth" ? egress.oauth : egress.providers.for({ baseUrl: target.url }),
			);
			yield* connectors.recordTest(
				at.workspaceId,
				at.connectorId,
				target.configurationUpdatedAt,
				found.ok ? found : { error: found.reason },
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

		listProjectBots: (canRead) =>
			operation(
				"listProjectBots",
				Effect.gen(function* () {
					const { reach } = canRead;
					const rows = yield* projectBotConnectorsIn(reach.workspace, reach.project.value);
					const shownProjects = yield* botProjectsShowingAddresses(
						reach,
						new Set(rows.map((row) => row.botProjectId)),
					);
					return rows.map(({ botProjectId, shown }) =>
						shownProjects.has(botProjectId) ? shown : { ...shown, url: null },
					);
				}),
			),

		setOnInProject: (canSet, { on, addressRevision }) =>
			operation(
				"setOnInProject",
				Effect.gen(function* () {
					const where = {
						workspaceId: canSet.workspace,
						projectId: canSet.project.value,
						connectorId: canSet.connector.value,
					};
					yield* connectors.setOnInProject({
						...where,
						botId: canSet.bot,
						on,
						addressRevision,
					});
					// Its manager sees its address.
					const [row] = yield* projectBotConnectorsIn(
						where.workspaceId,
						where.projectId,
						where.connectorId,
					);
					if (!row) return yield* new ConnectorNotFound();
					return row.shown;
				}),
			),

		listForRestriction: (canRestrict) =>
			operation(
				"listForRestriction",
				restrictableConnectorsIn(canRestrict.workspace, canRestrict.project.value),
			),

		switchOff: (_canRestrict, connector, target) =>
			operation(
				"switchOff",
				Effect.gen(function* () {
					const changed = yield* connectors.switchOff(
						target.workspace,
						target.project.value,
						connector.value,
					);
					if (!changed) return yield* new ResourceHidden({ resource: "project" });
					if (changed.kind === "github") {
						yield* computers.applyNetwork({
							workspaceId: target.workspace,
							projectId: target.project.value,
						});
					}
					return { id: changed.id, name: changed.name, enabled: changed.enabled, restricted: true };
				}),
			),

		get: (_canRead, connector, target) =>
			operation("get", requireConnector(locationIn(target, connector.value))),

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

		update: (_canManage, connector, target, changes) =>
			operation(
				"update",
				Effect.gen(function* () {
					const at = locationIn(target, connector.value);
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
					if (updated.kind === "github" && changes.enabled !== undefined) {
						yield* computers.applyNetwork(at);
					}
					if (ConnectorStore.changesReach(changes)) yield* discoverQuietly(at);
					return yield* requireConnector(at);
				}),
			),

		remove: (_canManage, connector, target) =>
			operation(
				"remove",
				Effect.gen(function* () {
					const at = locationIn(target, connector.value);
					if (!(yield* connectors.remove(at.workspaceId, at.projectId, at.connectorId))) {
						return yield* new ConnectorNotFound();
					}
				}),
			),

		test: (_canManage, connector, target) =>
			operation("test", test(locationIn(target, connector.value))),

		connectBuiltIn: (canManage, server) =>
			operation(
				"connectBuiltIn",
				Effect.gen(function* () {
					const { reach } = canManage;
					const session = yield* proveIsMember(reach.principal);
					const workspaceId = reach.workspace;
					const projectId = reach.project.value;
					yield* requireAllowedUrl(egress, server.url);
					const made = yield* connectors.create(workspaceId, projectId, session.member, {
						...server,
						auth: "oauth",
					});
					const started = yield* startSignIn({
						workspaceId,
						connectorId: made.id,
						serverUrl: made.url,
						startedByMemberId: session.member,
						startedBySessionId: session.session,
					}).pipe(Effect.tapError(() => connectors.remove(workspaceId, projectId, made.id)));
					if ("authorized" in started) {
						// Nothing to sign in to, so nothing the member asked for was made.
						yield* connectors.remove(workspaceId, projectId, made.id);
						return yield* new ConnectorNeededNoSignIn();
					}
					return { connectorId: made.id, authorizationUrl: started.authorizationUrl };
				}),
			),

		startSignIn: (canManage, connector, target) =>
			operation(
				"startSignIn",
				Effect.gen(function* () {
					const session = yield* proveIsMember(canManage.reach.principal);
					const at = locationIn(target, connector.value);
					const found = yield* requireConnector(at);
					if (found.auth !== "oauth") {
						return yield* new ConnectorDoesNotUseOAuth();
					}
					const started = yield* startSignIn({
						workspaceId: at.workspaceId,
						connectorId: at.connectorId,
						serverUrl: found.url,
						startedByMemberId: session.member,
						startedBySessionId: session.session,
					});
					if ("authorized" in started) {
						yield* discoverQuietly(at);
						return { authorizationUrl: null };
					}
					return { authorizationUrl: started.authorizationUrl };
				}),
			),

		signInWaitingOn: (state, session) =>
			operation("signInWaitingOn", connectors.byOauthState(state, session)),

		finishSignIn: (canManage, connector, target, callback) =>
			operation(
				"finishSignIn",
				Effect.gen(function* (): Effect.fn.Return<ConnectorSignInOutcome, never, Database> {
					const { reach } = canManage;
					const session = reach.principal.value;
					const unknown = { kind: "failed", failure: "unknown_state", at: undefined } as const;
					if (session._tag !== "MemberSession") return unknown;
					const at = locationIn(target, connector.value);
					const record = yield* connectors.oauthRecord(at.workspaceId, at.connectorId);
					if (
						record?.state !== callback.state ||
						record.startedByMemberId !== session.member ||
						record.startedBySessionId !== session.session
					)
						return unknown;
					const found = yield* Effect.option(requireConnector(at));
					if (found._tag === "None") return unknown;
					const project = { workspaceId: reach.workspace, projectId: reach.project.value };
					if (callback.error || !callback.code) {
						yield* Effect.logWarning("An authorization server refused a connector's sign-in", {
							error: callback.error,
							description: callback.errorDescription,
						});
						return { kind: "failed", failure: "refused", at: project };
					}
					const finished = yield* Effect.result(
						signIn.finish(
							at.workspaceId,
							at.connectorId,
							found.value.url,
							{ code: callback.code, state: callback.state },
							session.member,
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

export const layer = layerNoDeps.pipe(
	Layer.provide([ConnectorStore.layer, ConnectorSignIn.layer, ProjectComputers.layer]),
);

/**
 * Of the bots' default projects `botProjects`, those whose connectors'
 * addresses the member `reach` acts for sees in the project: every one for
 * a member who manages the project, and so turns connectors on there; for
 * anyone else, those of bots whose own connectors they may see. Anyone who
 * reaches the project sees whether each is on.
 */
const botProjectsShowingAddresses = <P, J>(
	reach: ReachesProject<P, J>,
	botProjects: ReadonlySet<string>,
) =>
	Effect.gen(function* () {
		const member = memberActing(reach.as);
		if (!member) return new Set<string>();
		if (memberManaging(reach.as, reach.facts)) return botProjects;
		const shown = new Set<string>();
		for (const projectId of botProjects) {
			const place = yield* query((db) =>
				reachFacts(db, projectId, { member: member.actor.memberId }),
			);
			if (
				place?.member &&
				memberReaches(place.member, place.project) &&
				mayInProjectAs(place.member, place.project, "connector.read")
			)
				shown.add(projectId);
		}
		return shown;
	});
