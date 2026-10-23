import {
	connectionToolKey,
	connectionToolMutating,
	isClientOwnedHeader,
} from "@sugabots/contracts";
import { type UserText, userText } from "@sugabots/errors";
import { asSchema, type Tool, tool } from "ai";
import { Schema } from "effect";
import type { ConnectionTarget } from "../../../providers/connections/connection-target.ts";
import { HTTP_CONNECTION_TOOLS } from "../../../providers/connections/http-tools.ts";
import { toolAccessOf } from "../../../providers/connections/tool-access.ts";
import { type EgressHttpClient, EgressRefused } from "../../../providers/network/egress.ts";
import type { OfferedTool } from "../connections.ts";
import { readUpTo } from "../web-fetch/fetch-page.ts";

const TIMEOUT_MS = 30_000;
const MAX_RESPONSE_BYTES = 5 * 1024 * 1024;
/** The response headers worth a model's attention; the rest are noise or the server's own business. */
const SHOWN_HEADERS = ["content-type", "location", "retry-after", "x-request-id"];
const REDACTED = "[credential]";

/**
 * An HTTP connection's method tools, offered like an MCP server's through
 * the turn's catalog. `fetch` is bound to the connection's address, so a
 * path that leads elsewhere, `..` included, is refused before anything is
 * sent. The connection's secret header is added after the model's input,
 * which may not set it, and is replaced in what comes back. Redirects are
 * answered as they are, never followed, so the secret goes nowhere else.
 */
export function httpTools(
	target: ConnectionTarget,
	fetch: EgressHttpClient,
): Record<string, OfferedTool> {
	const [secret] = Object.entries(target.headers);
	const redact = redactor(secret?.[1]);
	const credentialNote = secret
		? " Sugabots adds the connection's credential; you never see it, and must not ask for it or send one."
		: "";

	const offered: Record<string, OfferedTool> = {};
	for (const described of HTTP_CONNECTION_TOOLS) {
		const method = described.name.toUpperCase();
		const found: Tool = tool({
			description: `Send a ${method} request to ${target.handle} at ${target.url}. Give a path under that address.${credentialNote} The response's status, main headers and body come back. Redirects are not followed.`,
			inputSchema: (described.name === "get" || described.name === "delete"
				? requestSchema
				: requestWithBodySchema
			).pipe(Schema.toStandardSchemaV1, Schema.toStandardJSONSchemaV1),
			execute: async (request: HttpRequest, { abortSignal }) => {
				const refusal = refusedHeader(request.headers, secret?.[0]);
				if (refusal) return refusal;
				const headers = new Headers(request.headers);
				if (request.body !== undefined && !headers.has("content-type")) {
					headers.set("content-type", "application/json");
				}
				if (secret) headers.set(secret[0], secret[1]);
				const timeout = AbortSignal.timeout(TIMEOUT_MS);
				let response: Response;
				try {
					response = await fetch(urlUnder(target.url, request), {
						method,
						headers,
						body: request.body,
						signal: abortSignal ? AbortSignal.any([timeout, abortSignal]) : timeout,
					});
				} catch (cause) {
					if (cause instanceof EgressRefused) return failed(cause.userMessage);
					throw cause;
				}
				const bytes = await readUpTo(response, MAX_RESPONSE_BYTES);
				if (!bytes) {
					return failed(
						userText`The response was larger than ${MAX_RESPONSE_BYTES / 1024 / 1024} MB. Ask for less, for example a page at a time.`,
					);
				}
				return {
					status: response.status,
					headers: Object.fromEntries(
						SHOWN_HEADERS.flatMap((name) => {
							const value = response.headers.get(name);
							return value === null ? [] : [[name, redact(value)]];
						}),
					),
					body: redact(new TextDecoder().decode(bytes)),
				};
			},
		});
		const inputSchema = asSchema(found.inputSchema).jsonSchema;
		if ("then" in inputSchema) throw new Error(`The ${described.name} tool's schema isn't ready`);
		offered[connectionToolKey(target.handle, described.name)] = {
			tool: found,
			handle: target.handle,
			description: typeof found.description === "string" ? found.description : "",
			inputSchema,
			mutating: connectionToolMutating(described),
			access: toolAccessOf(target.toolAccess, described),
			connectionId: target.connectionId,
			connectionRevision: target.configurationRevision,
			remoteToolName: described.name,
		};
	}
	return offered;
}

const requestFields = {
	path: Schema.String.check(
		Schema.isPattern(/^\//, { message: "Start the path with /" }),
		Schema.isMaxLength(4_096),
	).annotate({ description: "The path under the connection's address, starting with /" }),
	query: Schema.optional(Schema.Record(Schema.String, Schema.String)).annotate({
		description: "Query parameters to add to the address",
	}),
	headers: Schema.optional(Schema.Record(Schema.String, Schema.String)).annotate({
		description: "Request headers",
	}),
};
const requestSchema = Schema.Struct(requestFields);
const requestWithBodySchema = Schema.Struct({
	...requestFields,
	body: Schema.optional(Schema.String.check(Schema.isMaxLength(1_000_000))).annotate({
		description:
			"The request body; sent as application/json unless a content-type header says otherwise",
	}),
});
type HttpRequest = typeof requestWithBodySchema.Type;

/** `path` and `query` on the end of `baseUrl`'s path, `..` resolved, so the bound client can tell where it leads. */
function urlUnder(baseUrl: string, { path, query = {} }: HttpRequest): string {
	const url = new URL(baseUrl);
	url.pathname = url.pathname.replace(/\/$/, "") + path;
	for (const [name, value] of Object.entries(query)) url.searchParams.append(name, value);
	return url.href;
}

/** Why the model may not send one of `headers`: the connection's own secret, or one the client owns. */
function refusedHeader(
	headers: Record<string, string> = {},
	secretHeader: string | undefined,
): Failed | undefined {
	const names = Object.keys(headers).map((name) => name.toLowerCase());
	if (secretHeader && names.includes(secretHeader.toLowerCase())) {
		return failed(
			userText`Sugabots adds the connection's credential in that header itself. Send the request without it.`,
		);
	}
	if (names.some(isClientOwnedHeader)) {
		return failed(userText`One of those headers is set by Sugabots itself. Leave it out.`);
	}
	return undefined;
}

/**
 * Replaces the secret in text a server sends back. A header's value is often
 * a scheme and then the token, `Bearer abc`, and a server that echoes it may
 * echo the token alone.
 */
function redactor(secret: string | undefined): (text: string) => string {
	if (!secret) return (text) => text;
	const token = secret.slice(secret.lastIndexOf(" ") + 1);
	return (text) => text.replaceAll(secret, REDACTED).replaceAll(token, REDACTED);
}

interface Failed {
	readonly status: "failed";
	readonly error: UserText;
}

const failed = (error: UserText): Failed => ({ status: "failed", error });
