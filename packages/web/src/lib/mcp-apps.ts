import type { AppBridge } from "@modelcontextprotocol/ext-apps/app-bridge";
import type { JsonValue, McpAppResource } from "@sugabots/contracts";
import { useQuery } from "@tanstack/react-query";
import { Effect } from "effect";
import { client } from "@/api.ts";

/** The MCP App `toolCallId`'s output is shown in, as its server gives it now. */
export function useMcpAppResource(toolCallId: string) {
	return useQuery({
		queryKey: ["mcp-apps", toolCallId],
		queryFn: ({ signal }) =>
			Effect.runPromise(client.api.mcpApps.resource({ params: { toolCallId } }), { signal }),
		staleTime: Number.POSITIVE_INFINITY,
	});
}

/** Calls one of the app's server's tools, through the tool call the app is shown with. */
export function callMcpAppTool(
	toolCallId: string,
	call: { name: string; arguments?: Record<string, unknown> },
): Promise<unknown> {
	return Effect.runPromise(
		client.api.mcpApps.callTool({
			params: { toolCallId },
			// Checked as JSON on the way out, like any payload.
			payload: { name: call.name, arguments: (call.arguments ?? {}) as Record<string, JsonValue> },
		}),
	);
}

/**
 * The policy an app's frame is held to: its own inline code, and only the
 * origins its server declared. A declared origin that is not a plain
 * `scheme://host[:port]` is dropped, so a server cannot write its own
 * directives into the policy.
 */
export function mcpAppContentPolicy(csp: McpAppResource["csp"]): string {
	const resources = csp.resourceDomains.filter(isDeclaredOrigin).join(" ");
	const connects = csp.connectDomains.filter(isDeclaredOrigin).join(" ");
	const frames = csp.frameDomains.filter(isDeclaredOrigin).join(" ");
	return [
		"default-src 'none'",
		`script-src 'unsafe-inline' 'unsafe-eval' blob: ${resources}`,
		`style-src 'unsafe-inline' ${resources}`,
		`img-src data: blob: ${resources}`,
		`font-src data: ${resources}`,
		`media-src data: blob: ${resources}`,
		`connect-src ${connects || "'none'"}`,
		`frame-src ${frames || "'none'"}`,
		"object-src 'none'",
		"base-uri 'none'",
		"form-action 'none'",
	].join("; ");
}

/** `scheme://host[:port]`, where the host may start with a `*.` wildcard. */
const ORIGIN = /^(https?|wss?):\/\/(\*\.)?[a-z0-9-]+(\.[a-z0-9-]+)*(:\d{1,5})?$/i;

function isDeclaredOrigin(candidate: string): boolean {
	return ORIGIN.test(candidate);
}

/**
 * Whether `output` is an MCP `CallToolResult` the app can be given, and not a
 * failure the model was told of or an output cut down for storage.
 */
export function isCallToolResult(output: unknown): output is CallToolResult {
	return (
		typeof output === "object" &&
		output !== null &&
		Array.isArray((output as { content?: unknown }).content)
	);
}

/** An MCP `CallToolResult`, as the bridge gives it to an app. */
export type CallToolResult = Parameters<AppBridge["sendToolResult"]>[0];
