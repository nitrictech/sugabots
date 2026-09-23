import { connectionToolKey, connectionToolMutating } from "@sugabots/contracts";
import type { Tool } from "ai";
import { Effect } from "effect";
import type { Database } from "../../database/database.ts";
import { connectServer, type ServerSession } from "../../providers/connections/mcp.ts";
import type { OAuthProviders } from "../../providers/connections/oauth.ts";
import type { ConnectionStore, ConnectionTarget } from "../../providers/connections/store.ts";
import type { EgressHttpClient, EgressHttpClients } from "../../providers/network/egress.ts";

/**
 * The tools an agent inherits from its pod for one turn (ADR 006).
 *
 * Opened per turn: one MCP session per enabled connection the pod has,
 * asked for its tools, and closed when the turn ends. Each tool is keyed by
 * the connection's handle and its own name, `linear__list_issues`, and
 * carries whether it may change something. That decides two things: whether
 * it is offered at all, since only read-only tools are until the owner allows
 * the rest on the connection, and how a failed turn after it is treated.
 *
 * A server that cannot be reached is left out of the turn, with a line in the
 * log, rather than the turn failing: the agent can still answer with what it
 * has, and the connection's own test is where the owner learns why.
 */

export interface OfferedTool {
	tool: Tool;
	/** Whether a call may change something at the other end (ADR 002). */
	mutating: boolean;
	connectionId: string;
	connectionRevision: number;
	remoteToolName: string;
}

export interface ConnectionToolSet {
	tools: Record<string, OfferedTool>;
	/** Ends every session behind these tools. */
	close(): Promise<void>;
}

export interface ConnectionTools {
	forPod(workspaceId: string, podId: string): Effect.Effect<ConnectionToolSet, never, Database>;
}

export interface ConnectionToolsOptions {
	connections: Pick<ConnectionStore, "targetsForPod">;
	/** Bound egress clients, so a session goes only to the connection's own address. */
	httpClients: EgressHttpClients;
	/** Opens a session with a server; the real one speaks MCP. */
	connect?: typeof connectServer;
	/** Where a connection signed in with OAuth keeps its tokens, and the client its calls go through. */
	oauth?: { providers: OAuthProviders; fetch: EgressHttpClient };
}

export function connectionTools({
	connections,
	httpClients,
	connect = connectServer,
	oauth,
}: ConnectionToolsOptions): ConnectionTools {
	async function offer(target: ConnectionTarget, workspaceId: string): Promise<Opened | undefined> {
		try {
			const session = await connect(
				{
					url: target.url,
					headers: target.headers,
					authProvider:
						target.auth === "oauth"
							? oauth?.providers.for(workspaceId, target.connectionId)
							: undefined,
				},
				// An OAuth server's refresh goes to its authorization server, which
				// may be elsewhere, so that client is not bound to the server's address.
				target.auth === "oauth" && oauth ? oauth.fetch : httpClients.for({ baseUrl: target.url }),
			);
			try {
				const tools: Record<string, OfferedTool> = {};
				for (const { described, tool } of await session.tools()) {
					const mutating = connectionToolMutating(described);
					if (mutating && !target.allowMutating) continue;
					tools[connectionToolKey(target.handle, described.name)] = {
						tool,
						mutating,
						connectionId: target.connectionId,
						connectionRevision: target.configurationRevision,
						remoteToolName: described.name,
					};
				}
				return { session, tools };
			} catch (cause) {
				await session.close();
				throw cause;
			}
		} catch (cause) {
			console.error(`Connection ${target.handle} left out of the turn`, cause);
			return undefined;
		}
	}

	return {
		forPod: (workspaceId, podId) =>
			Effect.gen(function* () {
				const targets = yield* connections.targetsForPod(workspaceId, podId);
				if (targets.length === 0) return nothingOffered;
				const opened = (yield* Effect.promise(() =>
					Promise.all(targets.map((target) => offer(target, workspaceId))),
				)).filter((one): one is Opened => one !== undefined);
				return {
					tools: Object.assign({}, ...opened.map((one) => one.tools)),
					close: async () => {
						await Promise.allSettled(opened.map((one) => one.session.close()));
					},
				};
			}),
	};
}

interface Opened {
	session: ServerSession;
	tools: Record<string, OfferedTool>;
}

const nothingOffered: ConnectionToolSet = { tools: {}, close: async () => undefined };

/** No connections at all, for a worker that has not been given any. */
export const noConnectionTools: ConnectionTools = {
	forPod: () => Effect.succeed(nothingOffered),
};
