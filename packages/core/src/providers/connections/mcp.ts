import { createMCPClient, type OAuthClientProvider, UnauthorizedError } from "@ai-sdk/mcp";
import type { ConnectionTool } from "@sugabots/contracts";
import type { Tool } from "ai";
import { VERSION } from "../../version.ts";
import type { EgressHttpClient } from "../network/egress.ts";

/**
 * Talking to an MCP server: one session over Streamable HTTP, through the
 * egress client the caller hands in, so the connection's address is checked
 * against the network policy and the client goes nowhere else.
 *
 * The AI SDK's client does the bridging from the server's tool list to tools a
 * turn's model can call. It is kept behind this module so a change in it lands
 * in one place (ADR 006). A failure to list is an answer with a reason rather
 * than a throw, so the settings page and a recorded test read the same
 * sentence.
 */

export type ServerTools = { ok: true; tools: ConnectionTool[] } | { ok: false; reason: string };

export interface ServerTarget {
	url: string;
	headers: Record<string, string>;
	/** For a server signed in to with OAuth: the SDK adds and refreshes the tokens itself. */
	authProvider?: OAuthClientProvider;
}

/** One of the server's tools: as the server described it, and as a model can call it. */
export interface ServerTool {
	described: ConnectionTool;
	tool: Tool;
}

export interface ServerSession {
	tools(): Promise<ServerTool[]>;
	close(): Promise<void>;
}

const SERVER_TIMEOUT_MS = 15_000;

/** Opens a session; the caller closes it when the turn or the test is done. */
export async function connectServer(
	target: ServerTarget,
	fetch: EgressHttpClient,
	timeoutMs = SERVER_TIMEOUT_MS,
): Promise<ServerSession> {
	const client = await createMCPClient({
		clientName: "sugabots",
		version: VERSION,
		transport: {
			type: "http",
			url: target.url,
			headers: target.headers,
			authProvider: target.authProvider,
			fetch,
		},
		initializationOptions: { timeout: timeoutMs },
	});
	return {
		tools: async () => {
			const listed = await client.listTools({ options: { timeout: timeoutMs } });
			const callable = client.toolsFromDefinitions(listed);
			return listed.tools.flatMap((definition) => {
				const tool = callable[definition.name];
				return tool
					? [
							{
								described: {
									name: definition.name,
									description: definition.description ?? null,
									readOnly: definition.annotations?.readOnlyHint ?? null,
									destructive: definition.annotations?.destructiveHint ?? null,
								},
								tool,
							},
						]
					: [];
			});
		},
		close: () => client.close().catch(() => undefined),
	};
}

/** Asks the server what it offers, in one short session. */
export async function listServerTools(
	target: ServerTarget,
	fetch: EgressHttpClient,
	timeoutMs = SERVER_TIMEOUT_MS,
): Promise<ServerTools> {
	try {
		const session = await connectServer(target, fetch, timeoutMs);
		try {
			const tools = await session.tools();
			return { ok: true, tools: tools.map((tool) => tool.described) };
		} finally {
			await session.close();
		}
	} catch (cause) {
		return { ok: false, reason: describe(cause) };
	}
}

/** The SDK's transport error names the status in its message; that is the part worth repeating. */
function describe(cause: unknown): string {
	if (cause instanceof UnauthorizedError) return "Sign in again to reconnect";
	const message = cause instanceof Error ? cause.message : String(cause);
	const status = /\bHTTP (\d{3})\b/.exec(message)?.[1];
	return status ? `The server answered HTTP ${status}` : message;
}
