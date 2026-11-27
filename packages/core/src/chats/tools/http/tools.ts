import {
	headerNameSchema,
	headerValueSchema,
	isClientOwnedHeader,
	MAX_URL_CHARACTERS,
} from "@sugabots/contracts";
import { userText } from "@sugabots/errors";
import { type Tool, tool } from "ai";
import { Schema } from "effect";
import type { ConnectorTarget } from "../../../providers/connectors/connector-target.ts";
import { HTTP_CONNECTOR_TOOLS } from "../../../providers/connectors/http-tools.ts";
import { type EgressHttpClient, EgressRefused } from "../../../providers/network/egress.ts";
import { readUpTo } from "../../../providers/web/fetch-page.ts";
import { type OfferedTool, offeredTool } from "../connector-catalog.ts";
import { readHandOff } from "../connector-hand-off.ts";
import { type Failed, failed } from "../failed.ts";
import { recordedCallOf } from "../recorded-call.ts";

const TIMEOUT_MS = 30_000;
const MAX_RESPONSE_BYTES = 5 * 1024 * 1024;
/** The response headers worth a model's attention; the rest are noise or the server's own business. */
const SHOWN_HEADERS = ["content-type", "location", "retry-after", "x-request-id"];
const REDACTED = "[credential]";
/** The header a server that keys repeated requests reads. */
const IDEMPOTENCY_KEY = "idempotency-key";

/**
 * An HTTP connector's method tools, offered like an MCP server's through
 * the turn's catalog. `fetch` is bound to the connector's address, so a
 * path that leads elsewhere, `..` included, is refused before anything is
 * sent. The connector's secret header is added after the model's input,
 * which may not set it, and is replaced in what comes back. Redirects are
 * answered as they are, never followed, so the secret goes nowhere else.
 */
export function httpTools(
	target: ConnectorTarget,
	fetch: EgressHttpClient,
): Record<string, OfferedTool> {
	const [secret] = Object.entries(target.headers);
	const redact = redactor(secret?.[1]);
	const credentialNote = secret
		? " Sugabots adds the connector's credential; you never see it, and must not ask for it or send one."
		: "";

	const offered: Record<string, OfferedTool> = {};
	for (const described of HTTP_CONNECTOR_TOOLS) {
		const method = described.name.toUpperCase();
		const found: Tool = tool({
			description: `Send a ${method} request to ${target.handle} at ${target.url}. Give a path under that address.${credentialNote} The response's status, main headers and body come back. Redirects are not followed.`,
			inputSchema: (described.name === "get" || described.name === "delete"
				? requestSchema
				: requestWithBodySchema
			).pipe(Schema.toStandardSchemaV1, Schema.toStandardJSONSchemaV1),
			execute: async (request: HttpRequest, { abortSignal, context }) => {
				const refusal = refusedHeader(request.headers, secret?.[0]);
				if (refusal) return refusal;
				const headers = new Headers(request.headers);
				// A request that may change something is sent once a call, under the id
				// its call was recorded as, so a server that keys on it does it once
				// even when the call is sent again.
				const recorded = recordedCallOf(context);
				if (method !== "GET" && recorded) {
					if (secret?.[0].toLowerCase() === IDEMPOTENCY_KEY)
						return failed(
							userText`This connector uses Idempotency-Key for its credential. Change its credential header before sending a request that can change something.`,
						);
					headers.set(IDEMPOTENCY_KEY, recorded);
				}
				if (request.body !== undefined && !headers.has("content-type")) {
					headers.set("content-type", "application/json");
				}
				if (secret) headers.set(secret[0], secret[1]);
				const timeout = AbortSignal.timeout(TIMEOUT_MS);
				let response: Response;
				try {
					response = await readHandOff(context)(() =>
						fetch(urlUnder(target.url, request), {
							method,
							headers,
							body: request.body,
							signal: abortSignal ? AbortSignal.any([timeout, abortSignal]) : timeout,
						}),
					);
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
		const [key, offeredAs] = offeredTool(target, described, found);
		offered[key] = offeredAs;
	}
	return offered;
}

const requestFields = {
	path: Schema.String.check(
		Schema.isPattern(/^\//, { message: "Start the path with /" }),
		Schema.isMaxLength(4_096),
	).annotate({ description: "The path under the connector's address, starting with /" }),
	query: Schema.optional(
		Schema.Record(
			Schema.String.check(Schema.isMaxLength(MAX_URL_CHARACTERS)),
			Schema.String.check(Schema.isMaxLength(MAX_URL_CHARACTERS)),
		).check(Schema.isMaxProperties(100)),
	).annotate({
		description: "Query parameters to add to the address",
	}),
	headers: Schema.optional(
		Schema.Record(headerNameSchema, headerValueSchema).check(Schema.isMaxProperties(20)),
	).annotate({
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

/** Why the model may not send one of `headers`: the connector's own secret, or one the client owns. */
export function refusedHeader(
	headers: Record<string, string> = {},
	secretHeader: string | undefined,
): Failed | undefined {
	const names = Object.keys(headers).map((name) => name.toLowerCase());
	if (secretHeader && names.includes(secretHeader.toLowerCase())) {
		return failed(
			userText`Sugabots adds the connector's credential in that header itself. Send the request without it.`,
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
