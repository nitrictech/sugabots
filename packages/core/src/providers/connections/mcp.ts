import { createMCPClient, type OAuthClientProvider, UnauthorizedError } from "@ai-sdk/mcp";
import type { ConnectionTool } from "@sugabots/contracts";
import type { Tool } from "ai";
import { UserMessage } from "../../user-message.ts";
import { VERSION } from "../../version.ts";
import { type EgressHttpClient, EgressRefused } from "../network/egress.ts";

/**
 * Talking to an MCP server: one session over Streamable HTTP, through the
 * egress client the caller hands in, so the connection's address is checked
 * against the network policy and the client goes nowhere else.
 *
 * The AI SDK's client does the bridging from the server's tool list to tools a
 * turn's model can call. It is kept behind this module so a change in it lands
 * in one place. A failure to list is an answer with a reason rather
 * than a throw, so the settings page and a recorded test read the same
 * sentence; `cause` is what went wrong, for the logs.
 */

type ServerTools =
	| { ok: true; tools: ConnectionTool[] }
	| { ok: false; reason: UserMessage; cause: unknown };

interface ServerTarget {
	url: string;
	headers: Record<string, string>;
	/** For a server signed in to with OAuth: the SDK adds and refreshes the tokens itself. */
	authProvider?: OAuthClientProvider;
}

/** One of the server's tools: as the server described it, and as a model can call it. */
interface ServerTool {
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
		return { ok: false, reason: describe(cause), cause };
	}
}

/**
 * What a person is told about `cause`, in our words. The SDK's transport error
 * names the server's HTTP status in its message, which is the one part of it
 * worth repeating.
 */
function describe(cause: unknown): UserMessage {
	if (cause instanceof UnauthorizedError) return UserMessage.of`Sign in again to reconnect`;
	if (cause instanceof EgressRefused) return cause.userMessage;
	const message = cause instanceof Error ? cause.message : String(cause);
	const status = /\bHTTP (\d{3})\b/.exec(message)?.[1];
	return status
		? UserMessage.of`The server answered HTTP ${Number(status)}`
		: UserMessage.of`The server could not be reached`;
}
