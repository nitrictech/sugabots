import { DisplayName, type DomainError, userText } from "@sugabots/errors";
import { APICallError } from "ai";
import { Duration, ErrorReporter, Schema } from "effect";
import { EgressRefused } from "../network/egress.ts";

/** Who a model request went to, as people see them in the Models settings. */
export interface RequestContext {
	readonly provider: DisplayName;
	readonly model: DisplayName;
}

/** The parts of a provider's error that a dialect uses to classify it. */
export interface FailureReport {
	/** HTTP status. Undefined for an error sent mid-stream. */
	status: number | undefined;
	/** The error's `code`, or its `type` if it has no code. */
	code: string | undefined;
	/** The provider's error message. */
	message: string | undefined;
}

/** Failures a dialect can identify from an error when the status code isn't enough. */
export type RecognizedFailure = "quota-exhausted" | "context-too-long" | "overloaded";

/** Maps a provider's error to a shared failure, or undefined to fall back to the status. */
export type RecognizeFailure = (report: FailureReport) => RecognizedFailure | undefined;

/** Provider and model names for the failure message, and the dialect's error mapping. */
export interface FailedRequest extends RequestContext {
	readonly recognize?: RecognizeFailure;
}

const requestFields = { provider: DisplayName.schema, model: DisplayName.schema };
const requestFieldsWithCause = { ...requestFields, cause: Schema.Defect() };

/** No provider in the workspace offers the model, or the one that does is switched off. */
export class ModelNotOffered
	extends Schema.TaggedError<ModelNotOffered>()("ModelNotOffered", { model: DisplayName.schema })
	implements DomainError
{
	readonly isRetryable = false;
	override readonly [ErrorReporter.severity] = "Info" as const;
	override get message() {
		return `No active provider offers the model "${this.model}"`;
	}
	get userMessage() {
		return userText`${this.model} isn't available: it, or the provider that offers it, has been switched off or removed in Models. A workspace admin can switch it back on, or you can choose another model.`;
	}
}

/** The provider that offers the model has no API key or sign-in yet. */
export class ProviderCredentialsMissing
	extends Schema.TaggedError<ProviderCredentialsMissing>()(
		"ProviderCredentialsMissing",
		requestFields,
	)
	implements DomainError
{
	readonly isRetryable = false;
	override readonly [ErrorReporter.severity] = "Info" as const;
	override get message() {
		return `${this.provider} has no API key or sign-in`;
	}
	get userMessage() {
		return userText`${this.provider}, which provides ${this.model}, has no API key or sign-in. A workspace admin can add one in Models.`;
	}
}

/** The provider's sign-in couldn't be renewed. */
export class ProviderOAuthRefreshFailed
	extends Schema.TaggedError<ProviderOAuthRefreshFailed>()(
		"ProviderOAuthRefreshFailed",
		requestFieldsWithCause,
	)
	implements DomainError
{
	readonly isRetryable = false;
	override readonly [ErrorReporter.severity] = "Warn" as const;
	override get message() {
		return `Renewing the sign-in to ${this.provider} failed: ${describe(this.cause)}`;
	}
	get userMessage() {
		return userText`We couldn't renew the workspace's sign-in to ${this.provider}. A workspace admin can sign in again in Models.`;
	}
}

/** The network policy refused the provider's address before anything was sent. */
export class ProviderAddressRefused
	extends Schema.TaggedError<ProviderAddressRefused>()("ProviderAddressRefused", {
		...requestFields,
		cause: Schema.instanceOf(EgressRefused),
	})
	implements DomainError
{
	readonly isRetryable = false;
	override readonly [ErrorReporter.severity] = "Warn" as const;
	override get message() {
		return `The network policy refused ${this.provider}'s address: ${this.cause.reason}`;
	}
	get userMessage() {
		return userText`We can't send requests to ${this.provider}'s address. ${this.cause.userMessage} A workspace admin can change the address in Models.`;
	}
}

/** No connection could be made: refused, no such host, or no answer in time. */
export class ProviderUnreachable
	extends Schema.TaggedError<ProviderUnreachable>()("ProviderUnreachable", requestFieldsWithCause)
	implements DomainError
{
	readonly isRetryable = true;
	override readonly [ErrorReporter.severity] = "Warn" as const;
	override get message() {
		return `${this.provider} could not be reached: ${describe(this.cause)}. Check the server is running and reachable from this one.`;
	}
	get userMessage() {
		return userText`We can't reach ${this.provider}, which provides ${this.model}. If it runs on your own computer, check it's on. Otherwise, try again in a few minutes.`;
	}
}

/** The connection dropped after it was made, partway through the response. */
export class ProviderConnectionLost
	extends Schema.TaggedError<ProviderConnectionLost>()(
		"ProviderConnectionLost",
		requestFieldsWithCause,
	)
	implements DomainError
{
	readonly isRetryable = true;
	override readonly [ErrorReporter.severity] = "Warn" as const;
	override get message() {
		return `The connection to ${this.provider} dropped: ${describe(this.cause)}`;
	}
	get userMessage() {
		return userText`We lost the connection to ${this.provider} partway through. Try again.`;
	}
}

/** The provider answered 401: it doesn't accept the key or sign-in. */
export class ProviderCredentialsRejected
	extends Schema.TaggedError<ProviderCredentialsRejected>()(
		"ProviderCredentialsRejected",
		requestFieldsWithCause,
	)
	implements DomainError
{
	readonly isRetryable = false;
	override readonly [ErrorReporter.severity] = "Warn" as const;
	override get message() {
		return describe(this.cause);
	}
	get userMessage() {
		return userText`${this.provider} didn't accept the workspace's API key. A workspace admin can update it in Models.`;
	}
}

/**
 * The key is fine, but the provider won't let the account use the model: a
 * 403, such as for the account's region or an age check.
 */
export class ProviderAccessDenied
	extends Schema.TaggedError<ProviderAccessDenied>()("ProviderAccessDenied", requestFieldsWithCause)
	implements DomainError
{
	readonly isRetryable = false;
	override readonly [ErrorReporter.severity] = "Warn" as const;
	override get message() {
		return describe(this.cause);
	}
	get userMessage() {
		return userText`${this.provider} won't let this workspace use ${this.model}, for example because of a setting on the account or where it's used from. A workspace admin can check the account with ${this.provider}, or you can choose another model.`;
	}
}

/** The provider wants payment: a 402, a 429 for an exhausted quota, or a 400 saying so. */
export class ProviderQuotaExhausted
	extends Schema.TaggedError<ProviderQuotaExhausted>()(
		"ProviderQuotaExhausted",
		requestFieldsWithCause,
	)
	implements DomainError
{
	readonly isRetryable = false;
	override readonly [ErrorReporter.severity] = "Warn" as const;
	override get message() {
		return describe(this.cause);
	}
	get userMessage() {
		return userText`${this.provider} turned the request down because of a billing problem, such as no credit left on the account or a spending limit on the API key. A workspace admin can check the account with ${this.provider}, or you can choose another model.`;
	}
}

/** The provider answered 429 for asking too often. */
export class ProviderRateLimited
	extends Schema.TaggedError<ProviderRateLimited>()("ProviderRateLimited", {
		...requestFieldsWithCause,
		retryAfter: Schema.optional(Schema.Duration),
	})
	implements DomainError
{
	readonly isRetryable = true;
	override readonly [ErrorReporter.severity] = "Warn" as const;
	override get message() {
		return describe(this.cause);
	}
	get userMessage() {
		const minutes = this.retryAfter && Math.ceil(Duration.toMinutes(this.retryAfter));
		if (!minutes) {
			return userText`${this.provider} is limiting how often this workspace can ask it. Try again shortly.`;
		}
		return userText`${this.provider} is limiting how often this workspace can ask it. Try again in ${minutes} ${minutes === 1 ? "minute" : "minutes"}.`;
	}
}

/** The provider doesn't recognise the model: a 404. */
export class ProviderModelNotFound
	extends Schema.TaggedError<ProviderModelNotFound>()(
		"ProviderModelNotFound",
		requestFieldsWithCause,
	)
	implements DomainError
{
	readonly isRetryable = false;
	override readonly [ErrorReporter.severity] = "Warn" as const;
	override get message() {
		return describe(this.cause);
	}
	get userMessage() {
		return userText`${this.provider} no longer offers ${this.model}. Choose another model.`;
	}
}

/** The prompt is longer than the model can read. */
export class ProviderContextLengthExceeded
	extends Schema.TaggedError<ProviderContextLengthExceeded>()(
		"ProviderContextLengthExceeded",
		requestFieldsWithCause,
	)
	implements DomainError
{
	readonly isRetryable = false;
	override readonly [ErrorReporter.severity] = "Warn" as const;
	override get message() {
		return describe(this.cause);
	}
	get userMessage() {
		return userText`The conversation is too long for ${this.model} to read. Start a new conversation, or choose a model that reads more.`;
	}
}

/** The provider refused the request itself: any other 4xx. */
export class ProviderRejectedRequest
	extends Schema.TaggedError<ProviderRejectedRequest>()(
		"ProviderRejectedRequest",
		requestFieldsWithCause,
	)
	implements DomainError
{
	readonly isRetryable = false;
	override readonly [ErrorReporter.severity] = "Warn" as const;
	override get message() {
		return describe(this.cause);
	}
	get userMessage() {
		return userText`${this.provider} didn't accept the request for ${this.model}. We've logged what it said. If it keeps happening, choose another model.`;
	}
}

/** The provider is overloaded: a 503, or what its dialect recognises as overloaded (e.g. a 529). */
export class ProviderOverloaded
	extends Schema.TaggedError<ProviderOverloaded>()("ProviderOverloaded", requestFieldsWithCause)
	implements DomainError
{
	readonly isRetryable = true;
	override readonly [ErrorReporter.severity] = "Warn" as const;
	override get message() {
		return describe(this.cause);
	}
	get userMessage() {
		return userText`${this.provider} is too busy to answer right now. Try again in a few minutes, or choose another model.`;
	}
}

/** The provider failed or timed out on its side: any other 5xx, or a 408. */
export class ProviderServerError
	extends Schema.TaggedError<ProviderServerError>()("ProviderServerError", requestFieldsWithCause)
	implements DomainError
{
	readonly isRetryable = true;
	override readonly [ErrorReporter.severity] = "Warn" as const;
	override get message() {
		return describe(this.cause);
	}
	get userMessage() {
		return userText`We're having trouble getting an answer from ${this.provider}. Try again in a few minutes. If it keeps happening, choose another model.`;
	}
}

/** A failure none of the others describe, such as a response the SDK couldn't read. */
export class ProviderRequestFailed
	extends Schema.TaggedError<ProviderRequestFailed>()(
		"ProviderRequestFailed",
		requestFieldsWithCause,
	)
	implements DomainError
{
	readonly isRetryable = true;
	override readonly [ErrorReporter.severity] = "Warn" as const;
	override get message() {
		return describe(this.cause);
	}
	get userMessage() {
		return userText`We couldn't get an answer from ${this.provider}. Try again, and if it keeps happening, choose another model.`;
	}
}

/** Why asking a model failed. */
export const RequestFailure = Schema.Union([
	ModelNotOffered,
	ProviderCredentialsMissing,
	ProviderOAuthRefreshFailed,
	ProviderAddressRefused,
	ProviderUnreachable,
	ProviderConnectionLost,
	ProviderCredentialsRejected,
	ProviderAccessDenied,
	ProviderQuotaExhausted,
	ProviderRateLimited,
	ProviderModelNotFound,
	ProviderContextLengthExceeded,
	ProviderRejectedRequest,
	ProviderOverloaded,
	ProviderServerError,
	ProviderRequestFailed,
]);
export type RequestFailure = typeof RequestFailure.Type;

/** Whether `failure` is one asking a model can end with. */
export const isRequestFailure = Schema.is(RequestFailure);

/** Socket error codes for a connection that was never made. */
const NOT_CONNECTED = new Set([
	"ECONNREFUSED",
	"ENOTFOUND",
	"EAI_AGAIN",
	"EHOSTUNREACH",
	"ENETUNREACH",
	"ETIMEDOUT",
	"UND_ERR_CONNECT_TIMEOUT",
]);

/** Socket error codes for a connection that dropped once made. */
const CONNECTION_DROPPED = new Set([
	"ECONNRESET",
	"EPIPE",
	"UND_ERR_SOCKET",
	"UND_ERR_BODY_TIMEOUT",
	"UND_ERR_HEADERS_TIMEOUT",
]);

/**
 * Classifies an error from a model request. `recognize` handles
 * provider-specific errors; the HTTP status and network errors cover the rest.
 */
export function classifyRequestFailure(cause: unknown, request: FailedRequest): RequestFailure {
	const { recognize, ...context } = request;
	const fields = { ...context, cause };
	if (APICallError.isInstance(cause) && cause.statusCode !== undefined) {
		const body = parsedBody(cause.responseBody);
		const recognized = recognize?.({
			status: cause.statusCode,
			code: errorCode(body),
			message: providerSaid(body) ?? shortText(cause.responseBody),
		});
		return classifyStatus(cause.statusCode, recognized, fields, cause);
	}
	// Providers send mid-stream errors as plain objects. An `Error` comes from our
	// code or the SDK, so the dialect doesn't see it.
	if (!(cause instanceof Error)) {
		const recognized = recognize?.({
			status: undefined,
			code: errorCode(cause),
			message: providerSaid(cause),
		});
		if (recognized) return recognizedFailure(recognized, fields);
	}
	const refused = findInChain(cause, (link) => link instanceof EgressRefused);
	if (refused) {
		return refused.reason === "unresolved"
			? new ProviderUnreachable(fields)
			: new ProviderAddressRefused({ ...context, cause: refused });
	}
	const code = findInChain(cause, hasErrorCode)?.code;
	if (code && NOT_CONNECTED.has(code)) return new ProviderUnreachable(fields);
	if (code && CONNECTION_DROPPED.has(code)) return new ProviderConnectionLost(fields);
	return new ProviderRequestFailed(fields);
}

function classifyStatus(
	status: number,
	recognized: RecognizedFailure | undefined,
	fields: RequestContext & { cause: unknown },
	cause: APICallError,
): RequestFailure {
	if (status === 401) return new ProviderCredentialsRejected(fields);
	if (status === 403) return new ProviderAccessDenied(fields);
	if (status === 402 || recognized === "quota-exhausted") {
		return new ProviderQuotaExhausted(fields);
	}
	if (status === 429) {
		return new ProviderRateLimited({
			...fields,
			retryAfter: parseRetryAfter(cause.responseHeaders),
		});
	}
	if (status === 404) return new ProviderModelNotFound(fields);
	if (status === 413 || recognized === "context-too-long") {
		return new ProviderContextLengthExceeded(fields);
	}
	if (status === 503 || recognized === "overloaded") return new ProviderOverloaded(fields);
	if (status === 408 || status >= 500) return new ProviderServerError(fields);
	return new ProviderRejectedRequest(fields);
}

/** How long a 429 asks to be left: `retry-after-ms`, which OpenAI sends, or `retry-after` in seconds. */
function parseRetryAfter(
	headers: Record<string, string> | undefined,
): Duration.Duration | undefined {
	const milliseconds = Number(headers?.["retry-after-ms"]);
	if (Number.isFinite(milliseconds) && milliseconds > 0) return Duration.millis(milliseconds);
	const seconds = Number(headers?.["retry-after"]);
	return Number.isFinite(seconds) && seconds > 0 ? Duration.seconds(seconds) : undefined;
}

/** How many causes deep the classifier looks, so a cycle can't run forever. */
const MAX_CAUSE_DEPTH = 5;

/** The first of `error` and the errors it was caused by that `matches`. */
function findInChain<T>(error: unknown, matches: (link: unknown) => link is T): T | undefined {
	for (let link = error, depth = 0; link !== undefined && depth < MAX_CAUSE_DEPTH; depth++) {
		if (matches(link)) return link;
		link = link instanceof Error ? link.cause : undefined;
	}
	return undefined;
}

/** Whether `link` carries a socket or undici error code, such as `ECONNREFUSED`. */
function hasErrorCode(link: unknown): link is { code: string } {
	return (
		typeof link === "object" &&
		link !== null &&
		typeof (link as { code?: unknown }).code === "string"
	);
}

/** The failure for a mid-stream error the dialect recognised. */
function recognizedFailure(
	recognized: RecognizedFailure,
	fields: RequestContext & { cause: unknown },
): RequestFailure {
	switch (recognized) {
		case "quota-exhausted":
			return new ProviderQuotaExhausted(fields);
		case "context-too-long":
			return new ProviderContextLengthExceeded(fields);
		case "overloaded":
			return new ProviderOverloaded(fields);
	}
}

/** What the provider said about a failed request, for the logs: its own sentence when it gave one. */
function describe(cause: unknown): string {
	if (APICallError.isInstance(cause)) {
		const said =
			providerSaid(parsedBody(cause.responseBody)) ??
			shortText(cause.responseBody) ??
			cause.message;
		return cause.statusCode ? `Provider returned ${cause.statusCode}: ${said}` : said;
	}
	if (cause instanceof Error) return cause.message;
	// An error reported mid-stream is often a plain object, such as `{ type: "overloaded_error" }`.
	try {
		return JSON.stringify(cause) ?? String(cause);
	} catch {
		return String(cause);
	}
}

/** Parses a JSON error body. Google wraps its error in a one-element array, so unwrap it. */
function parsedBody(body: string | undefined): unknown {
	if (!body) return undefined;
	try {
		const parsed: unknown = JSON.parse(body);
		return Array.isArray(parsed) && parsed.length === 1 ? parsed[0] : parsed;
	} catch {
		return undefined;
	}
}

/** The error object: `error` if that's an object, otherwise the body itself. */
function errorIn(reported: unknown): Record<string, unknown> | undefined {
	if (typeof reported !== "object" || reported === null) return undefined;
	const nested = (reported as { error?: unknown }).error;
	return typeof nested === "object" && nested !== null
		? (nested as Record<string, unknown>)
		: (reported as Record<string, unknown>);
}

/** The error's `code`, or its `type` if it has no code. */
function errorCode(reported: unknown): string | undefined {
	const error = errorIn(reported);
	const code = error?.code ?? error?.type;
	return typeof code === "string" ? code : undefined;
}

/**
 * The provider's error message: `message`, or `error` when that's a string
 * (xAI sends its message there).
 */
function providerSaid(reported: unknown): string | undefined {
	const message = errorIn(reported)?.message;
	if (typeof message === "string" && message) return message;
	const nested = (reported as { error?: unknown } | null | undefined)?.error;
	return typeof nested === "string" && nested ? nested : undefined;
}

/** A non-JSON body, if it's short enough to be an error message rather than an HTML page. */
function shortText(body: string | undefined): string | undefined {
	return body && body.length <= 300 && parsedBody(body) === undefined ? body : undefined;
}
