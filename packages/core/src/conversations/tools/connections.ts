export * as ConnectionTools from "./connections.ts";

import {
	type ConnectionAccess,
	connectionToolKey,
	connectionToolMutating,
} from "@sugabots/contracts";
import type { JSONSchema7, Tool } from "ai";
import { Clock, Context, Duration, Effect, Layer } from "effect";
import type { Database } from "../../database/database.ts";
import { ConnectionRepository } from "../../providers/connections/connection-repository.ts";
import { ConnectionSignIn } from "../../providers/connections/connection-sign-in.ts";
import type { ConnectionTarget } from "../../providers/connections/connection-target.ts";
import {
	connectServer,
	type ServerListing,
	type ServerSession,
} from "../../providers/connections/mcp.ts";
import type { OAuthProviders } from "../../providers/connections/oauth.ts";
import { toolAccessOf } from "../../providers/connections/tool-access.ts";
import {
	Egress,
	type EgressHttpClient,
	type EgressHttpClients,
} from "../../providers/network/egress.ts";

/**
 * The tools an agent inherits from its pod for one turn.
 *
 * A connection's tool list is kept between turns while fresh and unedited;
 * its session opens when a turn first needs it. Each tool is keyed by
 * the connection's handle and its own name, `linear__list_issues`, and
 * carries whether it may change something, which decides how a failed turn
 * after it is treated, and what the pod's bots may do with it. A call to a
 * tool set to `off` is refused. A tool nobody has chosen for is treated as
 * `toolAccessOf` says.
 * A connection whose every tool is off is not opened at all.
 *
 * A server that cannot be reached is left out of the turn, with a line in the
 * log, rather than the turn failing: the agent can still answer with what it
 * has, and the connection's own test is where the owner learns why.
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
	/** Ends every session behind these tools. */
	close(): Promise<void>;
}

export interface Interface {
	forPod(workspaceId: string, podId: string): Effect.Effect<ConnectionToolSet, never, Database>;
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
	});
});

export const layerNoDeps = Layer.effect(Service, make);

export const layer = layerNoDeps.pipe(
	Layer.provide([ConnectionRepository.layer, ConnectionSignIn.layer]),
);

/** Lets a server's changed tools reach turns without the connection being edited. */
const LISTING_LIFETIME = Duration.minutes(15);

interface KeptListing {
	listing: ServerListing;
	revision: number;
	listedAt: number;
}

export interface Parts {
	connections: Pick<ConnectionRepository.Interface, "targetsForPod">;
	/** Bound egress clients, so a session goes only to the connection's own address. */
	httpClients: EgressHttpClients;
	/** Opens a session with a server; the real one speaks MCP. */
	connect?: typeof connectServer;
	/**
	 * The clients connections signed in with OAuth carry their tokens with,
	 * read once per turn, and the client their calls go through.
	 */
	oauth?: { clients: Effect.Effect<OAuthProviders>; fetch: EgressHttpClient };
}

/** The tools built from `parts`, for `make` and for a case that supplies its own. */
export function from({
	connections,
	httpClients,
	connect = connectServer,
	oauth,
}: Parts): Interface {
	const kept = new Map<string, KeptListing>();

	return {
		forPod: (workspaceId, podId) =>
			Effect.gen(function* () {
				const targets = yield* connections.targetsForPod(workspaceId, podId);
				if (targets.length === 0) return nothingOffered;
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
					const known = kept.get(target.connectionId);
					if (
						known &&
						known.revision === target.configurationRevision &&
						now - known.listedAt < Duration.toMillis(LISTING_LIFETIME)
					) {
						return known.listing;
					}
					const listing = await (await openSession(target)).list();
					kept.set(target.connectionId, {
						listing,
						revision: target.configurationRevision,
						listedAt: now,
					});
					return listing;
				};
				const offered = yield* Effect.forEach(
					targets,
					(target) =>
						Effect.tryPromise(() => loadListing(target)).pipe(
							Effect.map((listing) => buildOfferedTools(target, listing, openSession)),
							Effect.catch((failure) =>
								Effect.as(
									Effect.logError(
										`Connection ${target.handle} left out of the turn`,
										failure.cause,
									),
									{},
								),
							),
						),
					{ concurrency: "unbounded" },
				);
				return {
					tools: Object.assign({}, ...offered),
					close: async () => {
						await Promise.allSettled(
							[...sessions.values()].map((session) => session.then((open) => open.close())),
						);
					},
				};
			}),
	};
}

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

const nothingOffered: ConnectionToolSet = { tools: {}, close: async () => undefined };

/** No connections at all, for a case that offers a turn none. */
export const none: Interface = {
	forPod: () => Effect.succeed(nothingOffered),
};
