import { createMCPClient, type OAuthClientProvider, UnauthorizedError } from "@ai-sdk/mcp";
import type { ConnectionProblem, ConnectionTool } from "@sugabots/contracts";
import type { Tool } from "ai";
import { UserMessage } from "../../user-message.ts";
import { VERSION } from "../../version.ts";
import { type EgressHttpClient, EgressRefused } from "../network/egress.ts";
import type { ConnectionCredential } from "./connection-target.ts";

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
	| ({ ok: false; cause: unknown } & Failure);

/**
 * Why a server's tools could not be listed. `reason` is shown to people,
 * `problem` classifies it, and `detail` is an HTTP status, content type or
 * network error code, never text from the server's response.
 */
interface Failure {
	reason: UserMessage;
	problem: ConnectionProblem;
	detail?: string;
}

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

/**
 * listServerTools lists the tools of the server at `target.url` in one short
 * session. A failure is worded for `target.credential`.
 */
export async function listServerTools(
	target: ServerTarget & { credential: ConnectionCredential },
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
		return { ok: false, ...describe(cause, target.credential), cause };
	}
}

/**
 * describe returns the `Failure` for `cause`, worded for `credential`. Only the
 * HTTP status and content type are taken from the SDK's error message, because
 * the rest of it can quote the server's response.
 */
function describe(cause: unknown, credential: ConnectionCredential): Failure {
	if (cause instanceof EgressRefused) {
		return { reason: cause.userMessage, problem: "address_not_allowed" };
	}
	if (cause instanceof UnauthorizedError) {
		return { reason: refusedCredential(credential), problem: "unauthorized" };
	}
	const message = cause instanceof Error ? cause.message : String(cause);
	const status = /\bHTTP (\d{3})\b/.exec(message)?.[1];
	if (status) return answeredWith(Number(status), credential);
	const contentType = /Unexpected content type: ([\w.+-]+\/[\w.+-]+)/i.exec(message)?.[1];
	if (contentType) {
		return {
			reason: UserMessage.of`That address answers, but not as an MCP server. Check it's the server's MCP address, not a web page`,
			problem: "not_mcp_server",
			detail: contentType.toLowerCase(),
		};
	}
	return {
		reason: UserMessage.of`The server could not be reached. Check the address and port, and that the server is running`,
		problem: "unreachable",
		detail: networkErrorCode(cause),
	};
}

function answeredWith(status: number, credential: ConnectionCredential): Failure {
	const detail = `HTTP ${status}`;
	if (status === 401)
		return { reason: refusedCredential(credential), problem: "unauthorized", detail };
	if (status === 403) {
		return {
			reason: UserMessage.of`The server refused access. Check what the token or account is allowed to do`,
			problem: "forbidden",
			detail,
		};
	}
	if (status === 404 || status === 405) {
		return {
			reason: UserMessage.of`Nothing answers as an MCP server at that address. Check the path, which often ends in /mcp`,
			problem: "not_mcp_server",
			detail,
		};
	}
	return status >= 500
		? {
				reason: UserMessage.of`The server had a problem answering. Try again later`,
				problem: "server_error",
				detail,
			}
		: { reason: UserMessage.of`The server refused the request`, problem: "server_error", detail };
}

/**
 * refusedCredential returns the message for a server rejecting `credential`. A
 * rejected sign-in is fixed by signing in again; a rejected token or secret
 * has to be replaced.
 */
function refusedCredential(credential: ConnectionCredential): UserMessage {
	switch (credential) {
		case "oauth":
			return UserMessage.of`Sign in again to reconnect`;
		case "token":
			return UserMessage.of`The server didn't accept the access token. Check that it hasn't expired and was copied in full`;
		case "header":
			return UserMessage.of`The server didn't accept the secret. Check the secret and the header it's sent in`;
		case "none":
			return UserMessage.of`The server needs a sign-in or an access token`;
	}
}

/** The system's code for a network failure, such as `ECONNREFUSED`, from anywhere in the cause chain. */
function networkErrorCode(cause: unknown): string | undefined {
	for (let current = cause; current instanceof Error; current = current.cause) {
		const code = (current as { code?: unknown }).code;
		if (typeof code === "string" && /^[A-Z][A-Z_]+$/.test(code)) return code;
		if (current.name === "TimeoutError") return "timeout";
	}
	return undefined;
}

const PROBE_TIMEOUT_MS = 10_000;

/** An MCP `initialize` request, which serverOffersSignIn sends unauthenticated. */
const INITIALIZE_REQUEST = {
	jsonrpc: "2.0",
	id: 1,
	method: "initialize",
	params: {
		protocolVersion: "2025-06-18",
		capabilities: {},
		clientInfo: { name: "sugabots", version: VERSION },
	},
};

/**
 * serverOffersSignIn reports whether the server at `url` supports OAuth sign-in:
 * it answers an unauthenticated request with 401, and either its
 * `WWW-Authenticate` names protected resource metadata (RFC 9728) or it
 * publishes protected resource or authorization server metadata at a
 * well-known address. It reports false when the server can't be reached.
 */
export async function serverOffersSignIn(
	url: string,
	fetch: EgressHttpClient,
	timeoutMs = PROBE_TIMEOUT_MS,
): Promise<boolean> {
	const signal = AbortSignal.timeout(timeoutMs);
	try {
		const answer = await fetch(url, {
			method: "POST",
			headers: {
				"content-type": "application/json",
				accept: "application/json, text/event-stream",
			},
			body: JSON.stringify(INITIALIZE_REQUEST),
			signal,
		});
		await answer.body?.cancel();
		if (answer.status !== 401) return false;
		if (/^bearer\b.*\bresource_metadata="/i.test(answer.headers.get("www-authenticate") ?? "")) {
			return true;
		}
		for (const address of wellKnownMetadata(new URL(url))) {
			if (await publishesSignIn(address, fetch, signal)) return true;
		}
		return false;
	} catch {
		return false;
	}
}

/**
 * wellKnownMetadata returns the addresses `server` may publish OAuth metadata
 * at, in the order to try them: protected resource metadata for its path, then
 * for its origin, then authorization server metadata at its origin.
 */
function wellKnownMetadata(server: URL): string[] {
	const path = server.pathname.replace(/\/$/, "");
	return [
		...(path ? [`${server.origin}/.well-known/oauth-protected-resource${path}`] : []),
		`${server.origin}/.well-known/oauth-protected-resource`,
		`${server.origin}/.well-known/oauth-authorization-server`,
	];
}

async function publishesSignIn(address: string, fetch: EgressHttpClient, signal: AbortSignal) {
	const answer = await fetch(address, { headers: { accept: "application/json" }, signal });
	if (!answer.ok) {
		await answer.body?.cancel();
		return false;
	}
	const metadata: unknown = await answer.json().catch(() => undefined);
	if (typeof metadata !== "object" || metadata === null) return false;
	const { authorization_servers: servers, authorization_endpoint: endpoint } = metadata as Record<
		string,
		unknown
	>;
	return (Array.isArray(servers) && servers.length > 0) || typeof endpoint === "string";
}
