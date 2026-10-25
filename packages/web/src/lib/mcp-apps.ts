import type { AppBridge } from "@modelcontextprotocol/ext-apps/app-bridge";
import type { JsonValue, McpAppResource, ThreadUpdateEvent } from "@sugabots/contracts";
import { type QueryClient, useQuery } from "@tanstack/react-query";
import { Effect } from "effect";
import { client } from "@/api.ts";
import { parsePartialJson } from "@/lib/partial-json.ts";

/**
 * The MCP App `toolCallId`'s output is shown in, as its server gives it now.
 * `pending` reads it for a call the model is still writing, whose row doesn't
 * exist yet; the app read then stays the call's once it does.
 */
export function useMcpAppResource(toolCallId: string, pending?: PendingAppInput) {
	const pendingApp = pending && { threadId: pending.threadId, ...pending.app };
	return useQuery({
		queryKey: ["mcp-apps", toolCallId],
		queryFn: ({ signal }) =>
			Effect.runPromise(
				pendingApp
					? client.api.mcpApps.pendingResource({
							params: { threadId: pendingApp.threadId },
							query: { connectionId: pendingApp.connectionId, resourceUri: pendingApp.resourceUri },
						})
					: client.api.mcpApps.resource({ params: { toolCallId } }),
				{ signal },
			),
		staleTime: Number.POSITIVE_INFINITY,
	});
}

type InputDelta = Extract<ThreadUpdateEvent, { type: "tool_call.input_delta" }>;

/** The input of a call to an MCP App's tool, as far as the model has written it. */
export interface PendingAppInput {
	toolCallId: string;
	threadId: string;
	messageId: string;
	tool: string;
	app: InputDelta["app"];
	/** The raw JSON of the `call_tool` input so far. */
	text: string;
}

const appInputsKey = ["mcp-app-inputs"] as const;

/** Every app call's input being written, by tool call id. Kept for as long as the page is open. */
export function usePendingAppInputs(): ReadonlyMap<string, PendingAppInput> {
	return (
		useQuery({
			queryKey: appInputsKey,
			queryFn: () => new Map<string, PendingAppInput>(),
			staleTime: Number.POSITIVE_INFINITY,
			gcTime: Number.POSITIVE_INFINITY,
		}).data ?? new Map()
	);
}

export function addAppInput(queries: QueryClient, delta: InputDelta) {
	queries.setQueryData<ReadonlyMap<string, PendingAppInput>>(appInputsKey, (inputs = new Map()) => {
		const known = inputs.get(delta.toolCallId);
		const text = known?.text ?? "";
		// A duplicate is skipped; after a gap the input waits for the call's own.
		if (delta.offset !== text.length) return inputs;
		const next = new Map(inputs);
		next.set(delta.toolCallId, {
			toolCallId: delta.toolCallId,
			threadId: delta.threadId,
			messageId: delta.messageId,
			tool: delta.tool,
			app: delta.app,
			text: text + delta.text,
		});
		return next;
	});
}

/** The arguments in a `call_tool` input still being written, as far as they parse. */
export function partialArguments(text: string): Record<string, unknown> | undefined {
	const input = parsePartialJson(text);
	if (!isObject(input)) return undefined;
	const given = input.arguments;
	if (typeof given === "string") {
		const parsed = parsePartialJson(given);
		return isObject(parsed) ? parsed : undefined;
	}
	return isObject(given) ? given : undefined;
}

function isObject(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
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
