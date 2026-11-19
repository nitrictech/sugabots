export * as ConnectionTools from "./connections.ts";

import {
	type ConnectionAccess,
	type ConnectionPreset,
	connectionCatalog,
	connectionPresetFor,
	connectionToolKey,
	connectionToolMutating,
} from "@sugabots/contracts";
import type { JSONSchema7, Tool } from "ai";
import { Clock, Context, Duration, Effect, Layer } from "effect";
import { type Database, effectRunner } from "../../database/database.ts";
import type { ConversationFiles } from "../../files/conversation-files.ts";
import {
	ConnectionRepository,
	everyToolOff,
} from "../../providers/connections/connection-repository.ts";
import { ConnectionSignIn } from "../../providers/connections/connection-sign-in.ts";
import type { ConnectionTarget } from "../../providers/connections/connection-target.ts";
import type { Connected } from "../../providers/connections/github/connected.ts";
import { GitHubConnections } from "../../providers/connections/github/github-connections.ts";
import {
	connectServer,
	type ServerListing,
	type ServerSession,
} from "../../providers/connections/mcp.ts";
import { needsSignIn, type OAuthProviders } from "../../providers/connections/oauth.ts";
import { toolAccessOf } from "../../providers/connections/tool-access.ts";
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
 * The tools a bot has through connections for one turn: those of the project
 * the turn works in, and its own, its default project's. When both have a
 * connection with the same handle, the project's is used and the bot's left
 * out, so a name always means one connection.
 *
 * A connection's tool list is kept between turns while fresh and unedited;
 * its session opens when a turn first needs it. Each tool is keyed by
 * the connection's handle and its own name, `linear__list_issues`, and
 * carries whether it may change something, which decides how a failed turn
 * after it is treated, and what the bot may do with it. A call to a
 * tool set to `off` is refused. A tool nobody has chosen for is treated as
 * `toolAccessOf` says.
 * A connection whose every tool is off is not opened at all.
 *
 * A server that cannot be reached is left out of the turn, with a line in the
 * log, rather than the turn failing: the bot can still answer with what it
 * has, and the connection's own test is where the owner learns why. One whose
 * sign-in was refused is left out too, but named apart, since it stays out of
 * every turn until a person signs in again.
 *
 * A GitHub connection's tools are Sugabots' own (see `github/tools.ts`), with
 * no server to reach; they are offered the same way, keyed by its handle. So
 * are an HTTP connection's, a request per method (see `http/tools.ts`), and
 * an MCP server's augmentation tools (see `augmentations.ts`).
 */

export interface OfferedTool {
	tool: Tool;
	handle: string;
	description: string;
	/** The server's schema, before the client adapts it into `tool`. */
	inputSchema: JSONSchema7;
	/** Whether a call may change something at the other end. */
	mutating: boolean;
	/** Whether each call runs, waits for a person to allow it, or is refused. */
	access: ConnectionAccess;
	connectionId: string;
	connectionRevision: number;
	remoteToolName: string;
}

export interface ConnectionToolSet {
	tools: Record<string, OfferedTool>;
	/** Connections left out because their server couldn't be listed. */
	unavailable: string[];
	/** Connections left out until someone signs in again, each with the project that holds it. */
	signInExpired: ExpiredConnection[];
	/** What each connection's server says about using its tools, by handle. */
	instructions: Record<string, string>;
	/** Catalog servers the bot has not added. */
	addable: readonly ConnectionPreset[];
	/**
	 * Whether the tools are a project's and the bot's own together, so a
	 * handle both have is the project's.
	 */
	fromProjectAndBot: boolean;
	/** Ends every session behind these tools. */
	close(): Promise<void>;
}

/** A connection left out of a turn until someone signs in again. */
export interface ExpiredConnection {
	handle: string;
	/** The project whose Connections page it is signed in again from: a bot's default project, or one people made. */
	projectId: string;
}

export interface Interface {
	forTurn(
		workspaceId: string,
		projects: TurnProjects,
		turn: TurnSide,
	): Effect.Effect<ConnectionToolSet, never, Database>;
}

/** Whose connections a turn uses. */
interface TurnProjects {
	/** The project the turn works in, whose computer it uses; none for a system bot. */
	readonly projectId: string | null;
	/** The bot's own default project, whose connections it brings; none for a system bot. */
	readonly ownProjectId: string | null;
}

/** What a turn's tools work for and through, for the kinds whose tools are Sugabots' own. */
interface TurnSide {
	readonly turnId: string;
	readonly botId: string;
	readonly conversationId: string;
	/** The conversation's files, which a connection's upload tool sends from. */
	readonly files: Pick<ConversationFiles.Interface, "read">;
	/** The computer of the project the turn works in, while the turn may use it. */
	readonly workspace: Workspace | undefined;
	/** Whether the computer's provider signs its requests in, outside it. */
	readonly computerSignsIn: boolean;
}

export class Service extends Context.Service<Service, Interface>()(
	"@sugabots/core/ConnectionTools",
) {}

/**
 * The tools over the installation's egress. A connection's session is bound
 * to its own address, and one signed in with OAuth carries the tokens its row
 * holds.
 */
export const make = Effect.gen(function* () {
	const egress = yield* Egress.Service;
	const signIn = yield* ConnectionSignIn.Service;
	return from({
		connections: yield* ConnectionRepository.Service,
		httpClients: egress.providers,
		oauth: { clients: signIn.clients, fetch: egress.oauth },
		github: yield* GitHubConnections.Service,
	});
});

export const layerNoDeps = Layer.effect(Service, make);

export const layer = layerNoDeps.pipe(
	Layer.provide([ConnectionRepository.layer, ConnectionSignIn.layer, GitHubConnections.layer]),
);

/** Lets a server's changed tools reach turns without the connection being edited. */
const LISTING_LIFETIME = Duration.minutes(15);

/** Spares turns the wait for a server that just failed to answer. */
const FAILURE_LIFETIME = Duration.minutes(1);

interface KeptListing {
	listing: ServerListing;
	revision: number;
	listedAt: number;
}

export interface Parts {
	connections: Pick<ConnectionRepository.Interface, "targetsForProject">;
	/** Bound egress clients, so a session goes only to the connection's own address. */
	httpClients: EgressHttpClients;
	/** Opens a session with a server; the real one speaks MCP. */
	connect?: typeof connectServer;
	/**
	 * The clients connections signed in with OAuth carry their tokens with,
	 * read once per turn, and the client their calls go through.
	 */
	oauth?: { clients: Effect.Effect<OAuthProviders>; fetch: EgressHttpClient };
	/** The projects' GitHub apps; a case without one offers no GitHub tools. */
	github?: Pick<GitHubConnections.Interface, "forProject">;
}

/** The tools built from `parts`, for `make` and for a case that supplies its own. */
export function from({
	connections,
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
			if (!connected || everyToolOff(connected.connection)) {
				return { tools: {}, instructions: {} };
			}
			const run = effectRunner({
				runPromiseExit: Effect.runPromiseExitWith(yield* Effect.context<Database>()),
			});
			return {
				tools: gitHubTools({ connected, ...turn, run }),
				instructions: {
					[connected.connection.handle]: gitHubNote(connected, signsIn),
				},
			};
		});

	/**
	 * The connections of each of `projectIds`, earliest first, leaving out
	 * those whose handle an earlier one has.
	 */
	const connectionsOf = (workspaceId: string, projectIds: readonly string[]) =>
		Effect.gen(function* () {
			const taken = new Set<string>();
			const reached: OwnedTarget[] = [];
			const expired: (Pick<ConnectionTarget, "handle" | "url"> & ExpiredConnection)[] = [];
			let gitHub: { connected: Connected; projectId: string } | undefined;
			for (const projectId of projectIds) {
				const found = yield* connections.targetsForProject(workspaceId, projectId);
				const connected = github ? yield* github.forProject({ workspaceId, projectId }) : undefined;
				const isFree = (connection: { handle: string }) => !taken.has(connection.handle);
				const owned = <Connection>(connection: Connection) => ({ ...connection, projectId });
				reached.push(...found.targets.filter(isFree).map(owned));
				expired.push(...found.signInExpired.filter(isFree).map(owned));
				if (!gitHub && connected && isFree(connected.connection)) {
					gitHub = { connected, projectId };
				}
				for (const connection of [
					...found.targets,
					...found.signInExpired,
					...(connected ? [connected.connection] : []),
				]) {
					taken.add(connection.handle);
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
				} = yield* connectionsOf(workspaceId, projectIds);
				// One waiting on a sign-in is still connected, so it isn't offered to be added again.
				const addable = presetsAddableTo([...reached, ...expired]);
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
					conversationId: turn.conversationId,
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
				const openSession = (target: ConnectionTarget) => {
					let session = sessions.get(target.connectionId);
					if (!session) {
						session = connect(
							{
								url: target.url,
								headers: target.headers,
								authProvider:
									target.auth === "oauth"
										? providers?.for(workspaceId, target.connectionId)
										: undefined,
							},
							// An OAuth server's refresh goes to its authorization server, which
							// may be elsewhere, so that client is not bound to the server's address.
							target.auth === "oauth" && oauth
								? oauth.fetch
								: httpClients.for({ baseUrl: target.url }),
						);
						sessions.set(target.connectionId, session);
					}
					return session;
				};
				const loadListing = async (target: ConnectionTarget): Promise<ServerListing> => {
					const failure = `${target.connectionId}:${target.configurationRevision}`;
					const failed = failedAt.get(failure);
					if (failed !== undefined && now - failed < Duration.toMillis(FAILURE_LIFETIME)) {
						throw new Error("The server failed to answer moments ago");
					}
					const known = kept.get(target.connectionId);
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
					kept.set(target.connectionId, {
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
											`Connection ${target.handle} left out of the turn until someone signs in again`,
										),
										"sign_in_expired" as const,
									);
								}
								return Effect.as(
									Effect.logError(
										`Connection ${target.handle} left out of the turn`,
										failure.cause,
									),
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

/** Catalog servers whose host does not match any of the turn's `connections`. */
function presetsAddableTo(connections: readonly { url: string }[]): readonly ConnectionPreset[] {
	const installed = new Set(
		connections.flatMap((connection) => {
			const preset = connectionPresetFor(connection.url);
			return preset ? [preset.id] : [];
		}),
	);
	return connectionCatalog.filter((preset) => !installed.has(preset.id));
}

/** A connection a turn reaches, with the project that holds it. */
type OwnedTarget = ConnectionTarget & { projectId: string };

/** What asking a connection's server for its tools came to. */
type ListingOutcome = ServerListing | "unavailable" | "sign_in_expired";

function buildOfferedTools(
	target: ConnectionTarget,
	listing: ServerListing,
	openSession: (target: ConnectionTarget) => Promise<ServerSession>,
): Record<string, OfferedTool> {
	const tools: Record<string, OfferedTool> = {};
	for (const { described, inputSchema, tool } of listing.tools) {
		tools[connectionToolKey(target.handle, described.name)] = {
			tool: {
				...tool,
				execute: async (input, options) =>
					(await openSession(target)).run(listing, described.name, input, options),
			},
			handle: target.handle,
			description: described.description ?? "",
			inputSchema,
			mutating: connectionToolMutating(described),
			access: toolAccessOf(target.toolAccess, described),
			connectionId: target.connectionId,
			connectionRevision: target.configurationRevision,
			remoteToolName: described.name,
		};
	}
	return tools;
}

const nothingOffered: ConnectionToolSet = {
	tools: {},
	unavailable: [],
	signInExpired: [],
	instructions: {},
	addable: [],
	fromProjectAndBot: false,
	close: async () => undefined,
};

/** No connections at all, for a case that offers a turn none. */
export const none: Interface = {
	forTurn: () => Effect.succeed(nothingOffered),
};
