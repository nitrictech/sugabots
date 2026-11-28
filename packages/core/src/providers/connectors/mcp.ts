import { createMCPClient, type ListToolsResult } from "@ai-sdk/mcp";
import type { ConnectorTool } from "@sugabots/contracts";
import { type UserText, userText } from "@sugabots/errors";
import { type JSONSchema7, jsonSchema, type Tool, type ToolExecutionOptions } from "ai";
import { VERSION } from "../../version.ts";
import { type EgressHttpClient, EgressRefused } from "../network/egress.ts";
import { upstreamErrorText } from "../upstream-error-text.ts";
import { needsSignIn, type OAuthClient } from "./oauth.ts";

/**
 * Talking to an MCP server: one session over Streamable HTTP, through the
 * egress client the caller hands in, so the connector's address is checked
 * against the network policy and the client goes nowhere else.
 *
 * The AI SDK's client does the bridging from the server's tool list to tools a
 * turn's model can call. It is kept behind this module so a change in it lands
 * in one place. A failure to list is an answer with a reason rather
 * than a throw, so the settings page and a recorded test read the same
 * sentence; `cause` is what went wrong, for the logs.
 */

export type ServerToolDefinitions = ListToolsResult["tools"];

type ServerTools =
	| { ok: true; tools: ConnectorTool[]; definitions: ServerToolDefinitions }
	| { ok: false; reason: UserText; cause: unknown };

interface ServerTarget {
	url: string;
	headers: Record<string, string>;
	/** For a server signed in to with OAuth: the SDK adds and refreshes the tokens itself. */
	oauth?: OAuthClient;
}

/** One of the server's tools: as the server described it, and as a model can call it. */
interface ServerTool {
	described: ConnectorTool;
	inputSchema: JSONSchema7;
	tool: Pick<Tool, "inputSchema">;
}

/** A server's tool list, which any later session can run its tools from. */
export interface ServerListing {
	tools: ServerTool[];
	definitions: ListToolsResult;
	/** What the server says, when the session starts, about using its tools. */
	instructions: string | undefined;
}

export interface ServerSession {
	list(): Promise<ServerListing>;
	/** run calls `name` from `listing` without listing the tools again. */
	run(
		listing: ServerListing,
		name: string,
		input: unknown,
		options: ToolExecutionOptions<unknown>,
	): Promise<unknown>;
	close(signal?: AbortSignal): Promise<void>;
}

const SERVER_TIMEOUT_MS = 15_000;
const MAX_TOOL_LIST_PAGES = 32;
export const SERVER_CLOSE_TIMEOUT_MS = 2_000;

/** The JSON-RPC error a server answers with when it does not speak the protocol version asked for. */
const UNSUPPORTED_PROTOCOL_VERSION = -32022;

/** Opens a session; the caller closes it when the turn or the test is done. */
export async function connectServer(
	target: ServerTarget,
	fetch: EgressHttpClient,
): Promise<ServerSession> {
	const send = target.oauth?.fetch ?? fetch;
	let closeSignal: AbortSignal | undefined;
	let closeError: { cause: unknown } | undefined;
	const open = (protocolVersionDiscovery: boolean) =>
		createMCPClient({
			clientName: "sugabots",
			version: VERSION,
			transport: {
				type: "http",
				url: target.url,
				headers: target.headers,
				fetch: async (input, init) => {
					if (init?.method !== "DELETE" || !closeSignal) return send(input, init);
					// The SDK's client.close() takes no signal and suppresses DELETE errors.
					const signal = init.signal ? AbortSignal.any([init.signal, closeSignal]) : closeSignal;
					try {
						return await send(input, { ...init, signal });
					} catch (cause) {
						closeError = { cause };
						throw cause;
					}
				},
			},
			initializationOptions: { timeout: SERVER_TIMEOUT_MS },
			protocolVersionDiscovery,
		});
	// The SDK first asks for the newest protocol, and gives up when a server on an
	// older one says so rather than ignoring the request. Such a server still
	// answers the older handshake, which skipping discovery falls back to.
	const client = await open(true).catch((cause) => {
		if (!isServerError(cause) || cause.code !== UNSUPPORTED_PROTOCOL_VERSION) throw cause;
		return open(false);
	});
	return {
		list: async () => {
			const signal = AbortSignal.timeout(SERVER_TIMEOUT_MS);
			const definitions: ServerToolDefinitions = [];
			let cursor: string | undefined;
			for (let page = 0; page < MAX_TOOL_LIST_PAGES; page++) {
				const listed = await client.listTools({
					params: cursor === undefined ? undefined : { cursor },
					options: { signal, timeout: SERVER_TIMEOUT_MS },
				});
				for (const definition of listed.tools) definitions.push(definition);
				cursor = listed.nextCursor;
				if (cursor === undefined) {
					return {
						tools: definitions.map(describeTool),
						definitions: { tools: definitions },
						instructions: client.instructions,
					};
				}
			}
			throw new Error(`The MCP server listed more than ${MAX_TOOL_LIST_PAGES} pages of tools`);
		},
		run: async (listing, name, input, options) => {
			const definition = listing.definitions.tools.findLast((tool) => tool.name === name);
			if (!definition) throw new Error(`The listing has no tool called ${name}`);
			const execute = client.toolsFromDefinitions({ tools: [definition] })[name]?.execute;
			if (!execute) throw new Error(`The listing has no tool called ${name}`);
			try {
				return await execute(input, options);
			} catch (cause) {
				// The model is told why a server rejected a call, so it can correct it.
				const said = isServerError(cause) ? cause.message : httpErrorAnswer(cause);
				if (said === undefined) throw cause;
				const text = upstreamErrorText(said, [
					...Object.values(target.headers),
					...(target.oauth?.sentTokens() ?? []),
				]);
				return { isError: true, content: [{ type: "text", text }] };
			}
		},
		close: async (signal = AbortSignal.timeout(SERVER_CLOSE_TIMEOUT_MS)) => {
			closeSignal = signal;
			await client.close();
			if (closeError) throw closeError.cause;
		},
	};
}

function describeTool(definition: ServerToolDefinitions[number]): ServerTool {
	const inputSchema = definition.inputSchema as JSONSchema7;
	return {
		described: {
			name: definition.name,
			description: definition.description ?? null,
			readOnly: definition.annotations?.readOnlyHint ?? null,
			destructive: definition.annotations?.destructiveHint ?? null,
		},
		inputSchema,
		get tool() {
			return {
				inputSchema: jsonSchema({
					...inputSchema,
					properties: inputSchema.properties ?? {},
					additionalProperties: false,
				}),
			};
		},
	};
}

/** Asks the server what it offers, in one short session. */
export async function listServerTools(
	target: ServerTarget,
	fetch: EgressHttpClient,
): Promise<ServerTools> {
	try {
		const session = await connectServer(target, fetch);
		try {
			const { tools, definitions } = await session.list();
			return {
				ok: true,
				tools: tools.map((tool) => tool.described),
				definitions: definitions.tools,
			};
		} finally {
			await session.close().catch(() => undefined);
		}
	} catch (cause) {
		return { ok: false, reason: describe(cause, target), cause };
	}
}

/**
 * describe returns what a member is told about `cause`, worded for what
 * `target` sent. Only the HTTP status and content type are taken from the SDK's
 * error message, because the rest of it can quote the server's response.
 */
function describe(cause: unknown, target: ServerTarget): UserText {
	if (cause instanceof EgressRefused) return cause.userMessage;
	if (needsSignIn(cause)) return userText`Sign in again to reconnect`;
	const message = cause instanceof Error ? cause.message : String(cause);
	const status = Number(/\bHTTP (\d{3})\b/.exec(message)?.[1]);
	if (status === 401 && target.oauth) return userText`Sign in again to reconnect`;
	if (status === 401 && Object.keys(target.headers).length > 0) {
		return userText`The server didn't accept the access token or secret. Check that it hasn't expired and was copied in full (HTTP 401)`;
	}
	if (status === 401) return userText`The server needs an access token or a sign-in (HTTP 401)`;
	if (status === 403) {
		return userText`The server refused access. Check what the token or account is allowed to do (HTTP 403)`;
	}
	if (status === 404 || status === 405 || /Unexpected content type/.test(message)) {
		return userText`Nothing answers as an MCP server at that address. Check the path, which often ends in /mcp`;
	}
	if (status) return userText`The server answered with an error. Try again later (HTTP ${status})`;
	if (isServerError(cause)) {
		return userText`The server turned down the session. Try again later (MCP error ${cause.code})`;
	}
	return userText`The server could not be reached. Check the address and port, and that the server is running`;
}

/** isServerError reports whether `cause` is a server's JSON-RPC error answer, not a failure to reach it. */
function isServerError(cause: unknown): cause is Error & { code: number } {
	return (
		cause instanceof Error &&
		cause.name === "MCPClientError" &&
		typeof (cause as { code?: unknown }).code === "number"
	);
}

/**
 * httpErrorAnswer returns what a server said with an HTTP error status, or
 * undefined when `cause` is anything else. The SDK's own message is not used,
 * because it adds advice meant for whoever writes the client.
 */
function httpErrorAnswer(cause: unknown): string | undefined {
	if (!(cause instanceof Error) || cause.name !== "MCPClientError") return undefined;
	const { statusCode, responseBody } = cause as { statusCode?: unknown; responseBody?: unknown };
	if (typeof statusCode !== "number" || statusCode < 400) return undefined;
	const body = typeof responseBody === "string" ? responseBody.trim() : "";
	return body
		? `The call failed with HTTP ${statusCode}. The server said: ${body}`
		: `The call failed with HTTP ${statusCode}.`;
}
