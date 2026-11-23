export * as ConnectorTools from "./connectors.ts";

import {
	type BuiltInConnector,
	builtInConnectorFor,
	builtInConnectors,
	type ConnectorAccess,
	connectorToolKey,
	connectorToolWritesOrDeletes,
} from "@sugabots/contracts";
import type { JSONSchema7, Tool } from "ai";
import { Clock, Context, Duration, Effect, Layer } from "effect";
import { type Database, effectRunner } from "../../database/database.ts";
import type { ChatFileStore } from "../../files/chat-file-store.ts";
import { ConnectorSignIn } from "../../providers/connectors/connector-sign-in.ts";
import { ConnectorStore, everyToolOff } from "../../providers/connectors/connector-store.ts";
import type { ConnectorTarget } from "../../providers/connectors/connector-target.ts";
import type { Connected } from "../../providers/connectors/github/connected.ts";
import { GitHubConnectors } from "../../providers/connectors/github/github-connectors.ts";
import {
	connectServer,
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
import { offerAugmentationTools } from "./augmentations.ts";
import type { Workspace } from "./github/push-tool.ts";
import { gitHubNote, gitHubTools } from "./github/tools.ts";
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
 * has, and the connector's own test is where the owner learns why. One whose
 * sign-in was refused is left out too, but named apart, since it stays out of
 * every turn until a person signs in again.
 *
 * A GitHub connector's tools are Sugabots' own (see `github/tools.ts`), with
 * no server to reach; they are offered the same way, keyed by its handle. So
 * are an HTTP connector's, a request per method (see `http/tools.ts`), and
 * an MCP server's augmentation tools (see `augmentations.ts`).
 */

export interface OfferedTool {
	tool: Tool;
	handle: string;
	description: string;
	/** The server's schema, before the client adapts it into `tool`. */
	inputSchema: JSONSchema7;
	/** Whether a call may change something at the other end. */
	writeOrDelete: boolean;
	/** Whether each call runs, waits for a person to allow it, or is refused. */
	access: ConnectorAccess;
	connectorId: string;
	connectorRevision: number;
	remoteToolName: string;
}

export interface ConnectorToolSet {
	tools: Record<string, OfferedTool>;
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
export interface ExpiredConnector {
	handle: string;
	/** The project whose Connectors page it is signed in again from: a bot's default project, or one people made. */
	projectId: string;
}

export interface Interface {
	forTurn(
		workspaceId: string,
		projects: TurnProjects,
		turn: TurnSide,
	): Effect.Effect<ConnectorToolSet, never, Database>;
}

/** Whose connectors a turn uses. */
interface TurnProjects {
	/** The project the turn works in, whose computer it uses; none for a system bot. */
	readonly projectId: string | null;
	/** The bot's own default project, whose connectors it brings; none for a system bot. */
	readonly ownProjectId: string | null;
}

/** What a turn's tools work for and through, for the kinds whose tools are Sugabots' own. */
interface TurnSide {
	readonly turnId: string;
	readonly botId: string;
	readonly chatId: string;
	/** The chat's files, which a connector's upload tool sends from. */
	readonly files: Pick<ChatFileStore.Interface, "read">;
	/** The computer of the project the turn works in, while the turn may use it. */
	readonly workspace: Workspace | undefined;
	/** Whether the computer's provider signs its requests in, outside it. */
	readonly computerSignsIn: boolean;
}

export class Service extends Context.Service<Service, Interface>()(
	"@sugabots/core/ConnectorTools",
) {}

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

export const layerNoDeps = Layer.effect(Service, make);

export const layer = layerNoDeps.pipe(
	Layer.provide([ConnectorStore.layer, ConnectorSignIn.layer, GitHubConnectors.layer]),
);

/** Lets a server's changed tools reach turns without the connector being edited. */
const LISTING_LIFETIME = Duration.minutes(15);

/** Spares turns the wait for a server that just failed to answer. */
const FAILURE_LIFETIME = Duration.minutes(1);

interface KeptListing {
	listing: ServerListing;
	revision: number;
	listedAt: number;
}

export interface Parts {
	connectors: Pick<ConnectorStore.Interface, "targetsForProject">;
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
	github?: Pick<GitHubConnectors.Interface, "forProject">;
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

	/**
	 * The GitHub app's tools, and what the model is told of them. The computer
	 * is signed in only to the app of the project the turn works in.
	 */
	const gitHubOffered = (connected: Connected | undefined, signsIn: boolean, turn: TurnSide) =>
		Effect.gen(function* () {
			if (!connected || everyToolOff(connected.connector)) {
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
	const connectorsOf = (workspaceId: string, projectIds: readonly string[]) =>
		Effect.gen(function* () {
			const taken = new Set<string>();
			const reached: OwnedTarget[] = [];
			const expired: (Pick<ConnectorTarget, "handle" | "url"> & ExpiredConnector)[] = [];
			let gitHub: { connected: Connected; projectId: string } | undefined;
			for (const projectId of projectIds) {
				const found = yield* connectors.targetsForProject(workspaceId, projectId);
				const connected = github ? yield* github.forProject({ workspaceId, projectId }) : undefined;
				const isFree = (connector: { handle: string }) => !taken.has(connector.handle);
				const owned = <Connector>(connector: Connector) => ({ ...connector, projectId });
				reached.push(...found.targets.filter(isFree).map(owned));
				expired.push(...found.signInExpired.filter(isFree).map(owned));
				if (!gitHub && connected && isFree(connected.connector)) {
					gitHub = { connected, projectId };
				}
				for (const connector of [
					...found.targets,
					...found.signInExpired,
					...(connected ? [connected.connector] : []),
				]) {
					taken.add(connector.handle);
				}
			}
			return { reached, expired, gitHub };
		});

	return {
		forTurn: (workspaceId, { projectId, ownProjectId }, turn) =>
			Effect.gen(function* () {
				if (projectId === null) return nothingOffered;
				const projectIds =
					ownProjectId === null || ownProjectId === projectId
						? [projectId]
						: [projectId, ownProjectId];
				const fromProjectAndBot = projectIds.length > 1;
				const {
					reached,
					expired,
					gitHub: foundGitHub,
				} = yield* connectorsOf(workspaceId, projectIds);
				// One waiting on a sign-in is still connected, so it isn't offered to be added again.
				const addable = builtInConnectorsAddableTo([...reached, ...expired]);
				const signInExpired = expired.map(({ handle, projectId }) => ({ handle, projectId }));
				const endpointTools = reached
					.filter((target) => target.kind === "http")
					.map((target) => httpTools(target, httpClients.for({ baseUrl: target.url })));
				const gitHub = yield* gitHubOffered(
					foundGitHub?.connected,
					turn.computerSignsIn && foundGitHub?.projectId === projectId,
					turn,
				);
				const ownTools = {
					tools: Object.assign({}, ...endpointTools, gitHub.tools),
					instructions: gitHub.instructions,
				};
				const targets = reached.filter((target) => target.kind === "mcp");
				if (targets.length === 0) {
					return { ...nothingOffered, ...ownTools, signInExpired, addable, fromProjectAndBot };
				}
				const uploadSide: UploadSide = {
					chatId: turn.chatId,
					files: turn.files,
					computer: turn.workspace,
					upload: httpClients,
					run: effectRunner({
						runPromiseExit: Effect.runPromiseExitWith(yield* Effect.context<Database>()),
					}),
				};
				const providers = oauth ? yield* oauth.clients : undefined;
				const now = yield* Clock.currentTimeMillis;
				const sessions = new Map<string, Promise<ServerSession>>();
				const openSession = (target: ConnectorTarget) => {
					let session = sessions.get(target.connectorId);
					if (!session) {
						session = connect(
							{
								url: target.url,
								headers: target.headers,
								authProvider:
									target.auth === "oauth"
										? providers?.for(workspaceId, target.connectorId)
										: undefined,
							},
							// An OAuth server's refresh goes to its authorization server, which
							// may be elsewhere, so that client is not bound to the server's address.
							target.auth === "oauth" && oauth
								? oauth.fetch
								: httpClients.for({ baseUrl: target.url }),
						);
						sessions.set(target.connectorId, session);
					}
					return session;
				};
				const loadListing = async (target: ConnectorTarget): Promise<ServerListing> => {
					const failure = `${target.connectorId}:${target.configurationRevision}`;
					const failed = failedAt.get(failure);
					if (failed !== undefined && now - failed < Duration.toMillis(FAILURE_LIFETIME)) {
						throw new Error("The server failed to answer moments ago");
					}
					const known = kept.get(target.connectorId);
					if (
						known &&
						known.revision === target.configurationRevision &&
						now - known.listedAt < Duration.toMillis(LISTING_LIFETIME)
					) {
						return known.listing;
					}
					const listing = await openSession(target)
						.then((session) => session.list())
						.catch((cause) => {
							failedAt.set(failure, now);
							throw cause;
						});
					failedAt.delete(failure);
					kept.set(target.connectorId, {
						listing,
						revision: target.configurationRevision,
						listedAt: now,
					});
					return listing;
				};
				const listings = yield* Effect.forEach(
					targets,
					(target) =>
						Effect.tryPromise(() => loadListing(target)).pipe(
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
				const listed = targets.flatMap((target, index) => {
					const listing = listings[index];
					return typeof listing === "object" ? [{ target, listing }] : [];
				});
				const leftOut = (outcome: ListingOutcome) =>
					targets.filter((_, index) => listings[index] === outcome);
				return {
					tools: Object.assign(
						{},
						...listed.map(({ target, listing }) => ({
							...offerAugmentationTools(
								target,
								listing.tools.map(({ described }) => described),
								uploadSide,
							),
							...buildOfferedTools(target, listing, openSession),
						})),
						ownTools.tools,
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
					close: async () => {
						await Promise.allSettled(
							[...sessions.values()].map((session) => session.then((open) => open.close())),
						);
					},
				};
			}),
	};
}

/** Built-in connectors whose host does not match any of the turn's `connectors`. */
function builtInConnectorsAddableTo(
	connectors: readonly { url: string }[],
): readonly BuiltInConnector[] {
	const installed = new Set(
		connectors.flatMap((connector) => {
			const builtIn = builtInConnectorFor(connector.url);
			return builtIn ? [builtIn.id] : [];
		}),
	);
	return builtInConnectors.filter((builtIn) => !installed.has(builtIn.id));
}

/** A connector a turn reaches, with the project that holds it. */
type OwnedTarget = ConnectorTarget & { projectId: string };

/** What asking a connector's server for its tools came to. */
type ListingOutcome = ServerListing | "unavailable" | "sign_in_expired";

function buildOfferedTools(
	target: ConnectorTarget,
	listing: ServerListing,
	openSession: (target: ConnectorTarget) => Promise<ServerSession>,
): Record<string, OfferedTool> {
	const tools: Record<string, OfferedTool> = {};
	for (const { described, inputSchema, tool } of listing.tools) {
		tools[connectorToolKey(target.handle, described.name)] = {
			tool: {
				...tool,
				execute: async (input, options) =>
					(await openSession(target)).run(listing, described.name, input, options),
			},
			handle: target.handle,
			description: described.description ?? "",
			inputSchema,
			writeOrDelete: connectorToolWritesOrDeletes(described),
			access: toolAccessOf(target.toolAccess, described),
			connectorId: target.connectorId,
			connectorRevision: target.configurationRevision,
			remoteToolName: described.name,
		};
	}
	return tools;
}

const nothingOffered: ConnectorToolSet = {
	tools: {},
	unavailable: [],
	signInExpired: [],
	instructions: {},
	addable: [],
	fromProjectAndBot: false,
	close: async () => undefined,
};

/** No connectors at all, for a case that offers a turn none. */
export const none: Interface = {
	forTurn: () => Effect.succeed(nothingOffered),
};
