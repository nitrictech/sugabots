export * as ConnectorCatalog from "./connector-catalog.ts";

import {
	type BuiltInConnector,
	builtInConnectorFor,
	builtInConnectors,
	type ConnectorAccess,
	type ConnectorTool,
	connectorToolKey,
	connectorToolWritesOrDeletes,
} from "@sugabots/contracts";
import { ConnectorToolsUnavailable } from "@sugabots/contracts/errors/connectors";
import type { ApprovalRefused } from "@sugabots/contracts/errors/proofs";
import { asSchema, type JSONSchema7, type Tool } from "ai";
import { Clock, Context, Duration, Effect, Layer } from "effect";
import { type Database, effectRunner } from "../../database/database.ts";
import type { ChatFileStore } from "../../files/chat-file-store.ts";
import { type ResolvedTargets, sameResolvedTargets } from "../../operations/operation.ts";
import type { Principal } from "../../principal.ts";
import {
	discoverConnectorRevisions,
	proveCanReachConnector,
	type ReachesEnabledConnector,
} from "../../proofs/can-use-connector.ts";
import { named } from "../../proofs/proof.ts";
import {
	type ConnectorSessions,
	connectorSessions,
} from "../../providers/connectors/connector-sessions.ts";
import { ConnectorSignIn } from "../../providers/connectors/connector-sign-in.ts";
import {
	ConnectorStore,
	everyToolOff,
	fingerprintToolDefinitions,
} from "../../providers/connectors/connector-store.ts";
import type { ConnectorTarget } from "../../providers/connectors/connector-target.ts";
import type { Connected } from "../../providers/connectors/github/connected.ts";
import {
	GitHubConnectors,
	gitHubConnectorForProject,
} from "../../providers/connectors/github/github-connectors.ts";
import {
	connectServer,
	SERVER_CLOSE_TIMEOUT_MS,
	type ServerListing,
	type ServerSession,
} from "../../providers/connectors/mcp.ts";
import { needsSignIn, type OAuthProviders } from "../../providers/connectors/oauth.ts";
import { toolAccessOf } from "../../providers/connectors/tool-access.ts";
import {
	Egress,
	type EgressHttpClient,
	type EgressHttpClients,
} from "../../providers/network/egress.ts";
import { processLayer, Tier } from "../../tiers.ts";
import { offerAugmentationTools } from "./augmentations.ts";
import type { ComputerAtPlace } from "./computer/tools.ts";
import { gitHubNote, gitHubTools, resolveGitHubTargets } from "./github/tools.ts";
import { httpTools } from "./http/tools.ts";
import type { UploadSide } from "./signed-upload/tool.ts";

/**
 * The tools a bot has through connectors for one turn: those of the project
 * the turn works in, and its own, its default project's. When both have a
 * connector with the same handle, the project's is used and the bot's left
 * out, so a name always means one connector.
 *
 * A connector's tool list is kept between turns while fresh and unedited;
 * its session opens when a turn first needs it. Each tool is keyed by
 * the connector's handle and its own name, `linear__list_issues`, and
 * carries whether it may change something, which decides how a failed turn
 * after it is treated, and what the bot may do with it. A call to a
 * tool set to `off` is refused. A tool nobody has chosen for is treated as
 * `toolAccessOf` says.
 * A connector whose every tool is off is not opened at all.
 *
 * A server that cannot be reached is left out of the turn, with a line in the
 * log, rather than the turn failing: the bot can still answer with what it
 * has, and the connector's own test is where someone who manages it learns why. One whose
 * sign-in was refused is left out too, but named apart, since it stays out of
 * every turn until a member signs in again.
 *
 * A GitHub connector's tools are Sugabots' own (see `github/tools.ts`), with
 * no server to reach; they are offered the same way, keyed by its handle. So
 * are an HTTP connector's, a request per method (see `http/tools.ts`), and
 * an MCP server's augmentation tools (see `augmentations.ts`).
 */

export interface OfferedTool {
	tool: Tool;
	usesComputer?: (input: Readonly<Record<string, unknown>>) => boolean;
	resolveApprovalTargets?: (
		input: Readonly<Record<string, unknown>>,
	) => Effect.Effect<ResolvedTargets, ApprovalRefused>;
	described: Pick<ConnectorTool, "name" | "readOnly" | "destructive"> & {
		defaultAccess?: ConnectorAccess;
	};
	handle: string;
	description: string;
	/** The server's schema, before the client adapts it into `tool`. */
	inputSchema: JSONSchema7;
	/** Whether a call may change something at the other end. */
	writeOrDelete: boolean;
	/** Whether each call runs, waits for a member to allow it, or is refused. */
	access: ConnectorAccess;
	connectorId: string;
	connectorRevision: number;
	remoteToolName: string;
}

/** The connector a tool is offered for, with what somebody chose for its tools. */
type OfferingConnector = Pick<
	ConnectorTarget,
	"connectorId" | "handle" | "toolAccess" | "configurationRevision"
>;

/**
 * `tool`, offered as `connector`'s tool `described`, under the key the model
 * calls it by. Its description and schema are the tool's own unless given.
 */
export function offeredTool(
	connector: OfferingConnector,
	described: Pick<ConnectorTool, "name" | "readOnly" | "destructive"> & {
		defaultAccess?: ConnectorAccess;
	},
	tool: Tool,
	given: { description: string; inputSchema: JSONSchema7 } = {
		description: typeof tool.description === "string" ? tool.description : "",
		inputSchema: jsonSchemaOf(described.name, tool),
	},
): [string, OfferedTool] {
	return [
		connectorToolKey(connector.handle, described.name),
		{
			tool,
			described,
			handle: connector.handle,
			description: given.description,
			inputSchema: given.inputSchema,
			writeOrDelete: connectorToolWritesOrDeletes(described),
			access: toolAccessOf(connector.toolAccess, described),
			connectorId: connector.connectorId,
			connectorRevision: connector.configurationRevision,
			remoteToolName: described.name,
		},
	];
}

/**
 * `tool`'s input schema as JSON Schema. Throws for a schema still being made,
 * which the turn's catalog can't list or search.
 */
function jsonSchemaOf(name: string, tool: Tool): JSONSchema7 {
	const inputSchema = asSchema(tool.inputSchema).jsonSchema;
	if ("then" in inputSchema) throw new Error(`The ${name} tool's input schema isn't ready`);
	return inputSchema;
}

export interface ConnectorToolSet {
	tools: Record<string, OfferedTool>;
	refreshForApproval: ReadonlyMap<
		string,
		(tool: string) => Effect.Effect<OfferedTool | undefined, ConnectorToolsUnavailable>
	>;
	/** Connectors left out because their server couldn't be listed. */
	unavailable: string[];
	/** Connectors left out until someone signs in again, each with the project that holds it. */
	signInExpired: ExpiredConnector[];
	/** What each connector's server says about using its tools, by handle. */
	instructions: Record<string, string>;
	/** Built-in connectors the bot has not added. */
	addable: readonly BuiltInConnector[];
	/**
	 * Whether the tools are a project's and the bot's own together, so a
	 * handle both have is the project's.
	 */
	fromProjectAndBot: boolean;
	/** Ends every session behind these tools. */
	close(): Promise<void>;
}

/** A connector left out of a turn until someone signs in again. */
interface ExpiredConnector {
	handle: string;
	/** The project whose Connectors page it is signed in again from: a bot's default project, or one members made. */
	projectId: string;
}

export interface Interface {
	checkApproval<P, K>(
		reach: ReachesEnabledConnector<P, K>,
		tool: string,
		input: Readonly<Record<string, unknown>>,
		recordedTargets: ResolvedTargets | null,
	): Effect.Effect<boolean, ConnectorToolsUnavailable>;
	forTurn(
		workspaceId: string,
		projects: TurnProjects,
		turn: TurnSide,
		sessions?: ConnectorSessions,
	): Effect.Effect<ConnectorToolSet, never, Database>;
}

/** Whose connectors a turn uses. */
export interface TurnProjects {
	/** The project the turn works in, whose computer it uses; none for a system bot. */
	readonly projectId: string | null;
	/** The bot's own default project, whose connectors it brings; none for a system bot. */
	readonly ownProjectId: string | null;
}

/** What a turn's tools work for and through, for the kinds whose tools are Sugabots' own. */
export interface TurnSide {
	readonly principal: Principal;
	readonly turnId: string;
	readonly botId: string;
	readonly chatId: string;
	/** The chat's files, which a connector's upload tool sends from. */
	readonly files: Pick<ChatFileStore.Interface, "read">;
	/** The computer of the project the turn works in, while the turn may use it. */
	readonly computer: ComputerAtPlace | undefined;
	/** Whether the computer's provider signs its requests in, outside it. */
	readonly computerSignsIn: boolean;
}

export class Service extends Context.Service<Service, Interface>()(
	"@sugabots/core/ConnectorCatalog",
) {
	declare readonly [Tier]: "process";
}

/**
 * The tools over the server's egress. A connector's session is bound
 * to its own address, and one signed in with OAuth carries the tokens its row
 * holds.
 */
export const make = Effect.gen(function* () {
	const egress = yield* Egress.Service;
	const signIn = yield* ConnectorSignIn.Service;
	return from({
		connectors: yield* ConnectorStore.Service,
		httpClients: egress.providers,
		oauth: { clients: signIn.clients, fetch: egress.oauth },
		github: yield* GitHubConnectors.Service,
	});
});

export const layerNoDeps = processLayer(Layer.effect(Service, make));

export const layer = layerNoDeps.pipe(
	Layer.provide([ConnectorStore.layer, ConnectorSignIn.layer, GitHubConnectors.layer]),
);

/** Lets a server's changed tools reach turns without the connector being edited. */
export const LISTING_LIFETIME = Duration.minutes(15);

/** Spares turns the wait for a server that just failed to answer. */
const FAILURE_LIFETIME = Duration.minutes(1);

interface KeptListing {
	listing: ServerListing;
	revision: number;
	/** The revision the session opened under, before this listing was recorded. */
	sessionRevision: number;
	listedAt: number;
}

export interface Parts {
	connectors: Pick<ConnectorStore.Interface, "targetsForProject" | "recordListing">;
	/** Bound egress clients, so a session goes only to the connector's own address. */
	httpClients: EgressHttpClients;
	/** Opens a session with a server; the real one speaks MCP. */
	connect?: typeof connectServer;
	/**
	 * The clients connectors signed in with OAuth carry their tokens with,
	 * read once per turn, and the client their calls go through.
	 */
	oauth?: { clients: Effect.Effect<OAuthProviders>; fetch: EgressHttpClient };
	/** The projects' GitHub apps; a case without one offers no GitHub tools. */
	github?: Pick<GitHubConnectors.Interface, "forConnector">;
}

/** The tools built from `parts`, for `make` and for a case that supplies its own. */
export function from({
	connectors,
	httpClients,
	connect = connectServer,
	oauth,
	github,
}: Parts): Interface {
	const kept = new Map<string, KeptListing>();
	const failedAt = new Map<string, number>();

	const openSession = (
		workspaceId: string,
		target: ConnectorTarget,
		providers: OAuthProviders | undefined,
	) =>
		connect(
			{
				url: target.url,
				headers: target.headers,
				oauth:
					target.auth === "oauth"
						? providers?.for(workspaceId, target.connectorId, target.url)
						: undefined,
			},
			target.auth === "oauth" && oauth ? oauth.fetch : httpClients.for({ baseUrl: target.url }),
		);

	const recordListing = (workspaceId: string, target: ConnectorTarget, listing: ServerListing) =>
		connectors.recordListing(workspaceId, target, {
			tools: listing.tools.map(({ described }) => described),
			definitions: listing.definitions.tools,
		});

	/**
	 * The GitHub app's tools, and whether its repositories can be read in the computer.
	 */
	const gitHubOffered = (connected: Connected | undefined, signsIn: boolean, turn: TurnSide) =>
		Effect.gen(function* () {
			if (!connected?.connector.enabled || everyToolOff(connected.connector)) {
				return { tools: {}, instructions: {} };
			}
			const run = effectRunner({
				runPromiseExit: Effect.runPromiseExitWith(yield* Effect.context<Database>()),
			});
			return {
				tools: gitHubTools({ connected, ...turn, run }),
				instructions: {
					[connected.connector.handle]: gitHubNote(connected, signsIn),
				},
			};
		});

	/**
	 * The connectors of each of `projectIds`, earliest first, leaving out
	 * those whose handle an earlier one has.
	 */
	const connectorsOf = (workspaceId: string, projectIds: readonly string[], principal: Principal) =>
		Effect.gen(function* () {
			const taken = new Set<string>();
			const reached: OwnedTarget[] = [];
			const expired: ExpiredConnector[] = [];
			const installedUrls: string[] = [];
			const gitHub: Connected[] = [];
			for (const projectId of projectIds) {
				const found = yield* connectors.targetsForProject(workspaceId, projectId);
				const app = github
					? yield* gitHubConnectorForProject({ workspaceId, projectId })
					: undefined;
				const connected =
					github && app?.enabled && !everyToolOff(app)
						? yield* named(principal, app.id, (acting, id) =>
								proveCanReachConnector(acting, id).pipe(
									Effect.flatMap(github.forConnector),
									Effect.orElseSucceed(() => undefined),
								),
							)
						: undefined;
				const isFree = (connector: { handle: string }) => !taken.has(connector.handle);
				const owned = <Connector>(connector: Connector) => ({ ...connector, projectId });
				const candidates = found.targets.filter(isFree);
				const expiredCandidates = found.signInExpired.filter(isFree);
				const revisions = yield* discoverConnectorRevisions(
					principal,
					workspaceId,
					projectId,
					[...candidates, ...expiredCandidates].map(({ connectorId }) => connectorId),
				);
				const isAllowed = (
					candidate: Pick<ConnectorTarget, "connectorId" | "configurationRevision">,
				) => revisions.get(candidate.connectorId) === candidate.configurationRevision;
				const allowed = candidates.filter(isAllowed);
				const allowedExpired = expiredCandidates.filter(isAllowed);
				reached.push(...allowed.map(owned));
				expired.push(...allowedExpired.map(({ handle }) => ({ handle, projectId })));
				installedUrls.push(...found.installedUrls);
				if (connected && isFree(connected.connector)) {
					gitHub.push(connected);
				}
				for (const handle of [
					...allowed.map(({ handle }) => handle),
					...allowedExpired.map(({ handle }) => handle),
					...(connected ? [connected.connector.handle] : []),
				]) {
					taken.add(handle);
				}
			}
			return { reached, expired, gitHub, installedUrls };
		});

	return {
		checkApproval: (reach, tool, input, recordedTargets) =>
			Effect.gen(function* () {
				if (reach.connectorKind === "http") return true;
				if (reach.connectorKind === "github") {
					const connected = github && (yield* github.forConnector(reach));
					if (!connected) return false;
					const current = yield* Effect.option(resolveGitHubTargets(connected, tool, input));
					if (current._tag === "None") return false;
					const {
						computer: _computer,
						provider: _provider,
						machine: _machine,
						...recorded
					} = recordedTargets ?? {};
					return sameResolvedTargets(recorded, current.value);
				}
				const { targets } = yield* connectors.targetsForProject(reach.workspace, reach.project);
				const target = targets.find(({ connectorId }) => connectorId === reach.connector.value);
				if (!target || target.configurationRevision !== reach.revision) return false;
				const providers = oauth ? yield* oauth.clients : undefined;
				const listing = yield* Effect.acquireUseRelease(
					Effect.tryPromise(() => openSession(reach.workspace, target, providers)),
					(session) => Effect.tryPromise(() => session.list()),
					(session) =>
						Effect.tryPromise((signal) => session.close(signal)).pipe(
							Effect.timeout(Duration.millis(SERVER_CLOSE_TIMEOUT_MS)),
							Effect.catch((cause) =>
								Effect.logWarning("The connector's approval session failed to close", cause),
							),
							Effect.forkDetach({ uninterruptible: false }),
							Effect.asVoid,
						),
				).pipe(
					Effect.mapError(
						({ cause }) => new ConnectorToolsUnavailable({ during: "approval", cause }),
					),
				);
				return (yield* recordListing(reach.workspace, target, listing)) === reach.revision;
			}),
		forTurn: (workspaceId, { projectId, ownProjectId }, turn, sessions = connectorSessions()) =>
			Effect.gen(function* () {
				if (projectId === null) return offerNothing();
				const projectIds =
					ownProjectId === null || ownProjectId === projectId
						? [projectId]
						: [projectId, ownProjectId];
				const fromProjectAndBot = projectIds.length > 1;
				const {
					reached,
					expired: signInExpired,
					gitHub: foundGitHub,
					installedUrls,
				} = yield* connectorsOf(workspaceId, projectIds, turn.principal);
				const addable = builtInConnectorsAddableTo(installedUrls);
				const endpointTools = reached
					.filter((target) => target.kind === "http")
					.map((target) => httpTools(target, httpClients.for({ baseUrl: target.url })));
				const gitHub = yield* Effect.forEach(foundGitHub, (connected) =>
					gitHubOffered(
						connected,
						turn.computerSignsIn && connected.connector.projectId === projectId,
						turn,
					),
				);
				const ownTools = {
					tools: Object.assign({}, ...endpointTools, ...gitHub.map(({ tools }) => tools)),
					instructions: Object.assign({}, ...gitHub.map(({ instructions }) => instructions)),
				};
				const targets = reached.filter((target) => target.kind === "mcp");
				if (targets.length === 0) {
					return { ...offerNothing(), ...ownTools, signInExpired, addable, fromProjectAndBot };
				}
				const uploadSide: UploadSide = {
					chatId: turn.chatId,
					files: turn.files,
					computer: turn.computer,
					upload: httpClients,
					run: effectRunner({
						runPromiseExit: Effect.runPromiseExitWith(yield* Effect.context<Database>()),
					}),
				};
				const providers = oauth ? yield* oauth.clients : undefined;
				const now = yield* Clock.currentTimeMillis;
				const useSession = <A>(
					target: ConnectorTarget,
					revision: number,
					work: (session: ServerSession) => Promise<A>,
				) =>
					sessions.use(
						`${target.connectorId}:${revision}`,
						() => openSession(workspaceId, target, providers),
						work,
					);
				const loadListing = (target: OwnedTarget) =>
					Effect.gen(function* () {
						const failure = `${target.connectorId}:${target.configurationRevision}`;
						const failed = failedAt.get(failure);
						if (failed !== undefined && now - failed < Duration.toMillis(FAILURE_LIFETIME)) {
							return "unavailable" as const;
						}
						const known = kept.get(target.connectorId);
						if (
							known &&
							known.revision === target.configurationRevision &&
							now - known.listedAt < Duration.toMillis(LISTING_LIFETIME)
						) {
							return { ...known, target };
						}
						const sessionRevision =
							known?.revision === target.configurationRevision
								? known.sessionRevision
								: target.configurationRevision;
						const listing = yield* Effect.tryPromise(() =>
							useSession(target, sessionRevision, (session) => session.list()).catch((cause) => {
								if (!sessions.closed) failedAt.set(failure, now);
								throw cause;
							}),
						);
						failedAt.delete(failure);
						const revision = yield* recordListing(workspaceId, target, listing);
						if (revision === undefined) return undefined;
						const recorded = {
							listing,
							revision,
							sessionRevision,
							listedAt: now,
						};
						kept.set(target.connectorId, recorded);
						return { ...recorded, target };
					});
				const loadCurrentListing = (target: OwnedTarget) =>
					Effect.gen(function* () {
						const listing = yield* loadListing(target);
						if (listing !== undefined) return listing;
						const { targets } = yield* connectors.targetsForProject(workspaceId, target.projectId);
						const current = targets.find(({ connectorId }) => connectorId === target.connectorId);
						if (!current) return "unavailable" as const;
						const revisions = yield* discoverConnectorRevisions(
							turn.principal,
							workspaceId,
							target.projectId,
							[current.connectorId],
						);
						if (revisions.get(current.connectorId) !== current.configurationRevision)
							return "unavailable" as const;
						return (
							(yield* loadListing({ ...current, projectId: target.projectId })) ?? "unavailable"
						);
					});
				const listings = yield* Effect.forEach(
					targets,
					(target) =>
						loadCurrentListing(target).pipe(
							Effect.catch((failure): Effect.Effect<ListingOutcome> => {
								if (needsSignIn(failure.cause)) {
									return Effect.as(
										Effect.logWarning(
											`Connector ${target.handle} left out of the turn until someone signs in again`,
										),
										"sign_in_expired" as const,
									);
								}
								return Effect.as(
									Effect.logError(`Connector ${target.handle} left out of the turn`, failure.cause),
									"unavailable" as const,
								);
							}),
						),
					{ concurrency: "unbounded" },
				);
				const listed = listings.flatMap((recorded) => {
					if (typeof recorded !== "object") return [];
					const { target, listing, revision, sessionRevision } = recorded;
					const current = targetWithListing(target, revision, listing);
					const use = <A>(work: (session: ServerSession) => Promise<A>) =>
						useSession(target, sessionRevision, work);
					const offer = (target: ConnectorTarget, listing: ServerListing) =>
						buildConnectorTools(target, listing, uploadSide, use);
					const refresh = (name: string) =>
						Effect.gen(function* () {
							const fresh = yield* Effect.tryPromise(() => use((session) => session.list())).pipe(
								Effect.tapError(({ cause }) =>
									Effect.logWarning("Checking an approved connector's tools failed", cause),
								),
								Effect.mapError(
									({ cause }) => new ConnectorToolsUnavailable({ during: "toolCall", cause }),
								),
							);
							const revision = yield* recordListing(workspaceId, current, fresh);
							if (revision === undefined) return undefined;
							const tools = offer(targetWithListing(current, revision, fresh), fresh);
							return tools[connectorToolKey(current.handle, name)];
						});
					return [{ target, listing, tools: offer(current, listing), refresh }];
				});
				const leftOut = (outcome: ListingOutcome) =>
					targets.filter((_, index) => listings[index] === outcome);
				return {
					tools: Object.assign({}, ...listed.map(({ tools }) => tools), ownTools.tools),
					refreshForApproval: new Map(
						listed.map(({ target, refresh }) => [target.connectorId, refresh]),
					),
					unavailable: leftOut("unavailable").map((target) => target.handle),
					signInExpired: [
						...signInExpired,
						...leftOut("sign_in_expired").map(({ handle, projectId }) => ({ handle, projectId })),
					],
					instructions: {
						...Object.fromEntries(
							listed.flatMap(({ target, listing }) =>
								listing.instructions ? [[target.handle, listing.instructions]] : [],
							),
						),
						...ownTools.instructions,
					},
					addable,
					fromProjectAndBot,
					close: sessions.close,
				};
			}),
	};
}

/** builtInConnectorsAddableTo returns built-in connectors whose hosts are absent from `installedUrls`. */
function builtInConnectorsAddableTo(installedUrls: readonly string[]): readonly BuiltInConnector[] {
	const installed = new Set(
		installedUrls.flatMap((url) => {
			const builtIn = builtInConnectorFor(url);
			return builtIn ? [builtIn.id] : [];
		}),
	);
	return builtInConnectors.filter((builtIn) => !installed.has(builtIn.id));
}

/** A connector a turn reaches, with the project that holds it. */
type OwnedTarget = ConnectorTarget & { projectId: string };

/** What asking a connector's server for its tools came to. */
type ListingOutcome = (KeptListing & { target: OwnedTarget }) | "unavailable" | "sign_in_expired";

function targetWithListing(target: ConnectorTarget, revision: number, listing: ServerListing) {
	return {
		...target,
		configurationRevision: revision,
		toolDefinitionsFingerprint: fingerprintToolDefinitions(listing.definitions.tools),
	};
}

function buildConnectorTools(
	target: ConnectorTarget,
	listing: ServerListing,
	upload: UploadSide,
	useSession: <A>(work: (session: ServerSession) => Promise<A>) => Promise<A>,
): Record<string, OfferedTool> {
	return {
		...offerAugmentationTools(
			target,
			listing.tools.map(({ described }) => described),
			upload,
		),
		...Object.fromEntries(
			listing.tools.map(({ described, inputSchema, tool }) =>
				offeredTool(
					target,
					described,
					{
						...tool,
						execute: (input, options) =>
							useSession((session) => session.run(listing, described.name, input, options)),
					},
					{ description: described.description ?? "", inputSchema },
				),
			),
		),
	};
}

/** No connector tools, made new for each caller, since the set's lists can be changed. */
const offerNothing = (): ConnectorToolSet => ({
	tools: {},
	refreshForApproval: new Map(),
	unavailable: [],
	signInExpired: [],
	instructions: {},
	addable: [],
	fromProjectAndBot: false,
	close: async () => undefined,
});

/** No connectors at all, for a case that offers a turn none. */
export const none: Interface = {
	checkApproval: () => Effect.succeed(false),
	forTurn: () => Effect.sync(offerNothing),
};
