import type { McpSdkServerConfigWithInstance } from "@anthropic-ai/claude-agent-sdk";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { CallToolRequestSchema, ListToolsRequestSchema } from "@modelcontextprotocol/sdk/types.js";
import type { OfferedTool } from "@sugabots/contracts/devices";

/** Which turn tools belong to: the lent agent's address, and the A2A context it was asked in. */
export interface AskedIn {
	readonly agentUrl: string;
	readonly contextId: string;
}

/** Sugabots' tools for a turn, reached through the device link and run on the server. */
export interface SugabotsTools {
	readonly list: (asked: AskedIn) => Promise<ReadonlyArray<OfferedTool>>;
	readonly call: (
		asked: AskedIn,
		name: string,
		input: unknown,
	) => Promise<{ text: string; isError: boolean }>;
}

/** What Claude Code calls the server's tools: `mcp__<server>__<tool>`. */
export const SUGABOTS_SERVER = "sugabots";

/**
 * The turn's Sugabots tools as an MCP server in this process, for one Claude
 * Code run, or nothing when the turn offers none. Each call goes to the
 * server, which runs it in the turn under the pod's rules.
 */
export async function sugabotsMcpServer(
	tools: SugabotsTools,
	asked: AskedIn,
): Promise<McpSdkServerConfigWithInstance | undefined> {
	const offered = await tools.list(asked);
	if (offered.length === 0) return undefined;
	const mcp = new McpServer(
		{ name: SUGABOTS_SERVER, version: "1.0.0" },
		{ capabilities: { tools: {} } },
	);
	// The tools come with JSON Schemas already, so they're served as they are
	// rather than declared one by one, which would need Zod schemas.
	mcp.server.setRequestHandler(ListToolsRequestSchema, async () => ({
		tools: offered.map(({ name, description, inputSchema }) => ({
			name,
			description,
			inputSchema: inputSchema as { type: "object" },
		})),
	}));
	mcp.server.setRequestHandler(CallToolRequestSchema, async ({ params }) => {
		const result = await tools.call(asked, params.name, params.arguments ?? {});
		return { content: [{ type: "text", text: result.text }], isError: result.isError };
	});
	return { type: "sdk", name: SUGABOTS_SERVER, instance: mcp };
}
