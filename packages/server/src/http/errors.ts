import type { ApiErrorCode, ErrorResponse } from "@sugabots/contracts";
import { Data, Effect } from "effect";
import type { ErrorHandler, NotFoundHandler } from "hono";
import { HTTPException } from "hono/http-exception";
import type { ContentfulStatusCode } from "hono/utils/http-status";

/**
 * One error envelope for the whole API. Nothing builds a failure response by
 * hand, so every client sees the same shape at every route
 * (`@sugabots/contracts`, `errorResponseSchema`).
 *
 * `HttpError` is a tagged error so a handler can `yield*` it directly, and so
 * `asHttpError` below can be exhaustive over a store's failure tags.
 */

const statusByCode: Record<ApiErrorCode, ContentfulStatusCode> = {
	bad_request: 400,
	unauthorized: 401,
	forbidden: 403,
	not_found: 404,
	conflict: 409,
	internal: 500,
};

export class HttpError extends Data.TaggedError("HttpError")<{
	readonly code: ApiErrorCode;
	readonly reason: string;
	readonly details: unknown;
}> {
	/** Positional, because a status and a sentence read better than a bag. */
	constructor(code: ApiErrorCode, reason: string, details?: unknown) {
		super({ code, reason, details });
	}

	get status(): ContentfulStatusCode {
		return statusByCode[this.code];
	}

	override get message() {
		return this.reason;
	}
}

/** Hono's own failures, and anything else that escapes a handler. */
function toHttpError(error: unknown): HttpError {
	if (error instanceof HttpError) {
		return error;
	}
	if (error instanceof HTTPException) {
		return new HttpError(codeForStatus(error.status), error.message);
	}
	// Unexpected: the message may name a table, a query or a file path, so it
	// goes to the log and not to the caller.
	return new HttpError("internal", "Internal server error");
}

const codeByStatus: Record<number, ApiErrorCode> = {
	400: "bad_request",
	401: "unauthorized",
	403: "forbidden",
	404: "not_found",
	409: "conflict",
	500: "internal",
};

function codeForStatus(status: number): ApiErrorCode {
	return codeByStatus[status] ?? (status < 500 ? "bad_request" : "internal");
}

function envelope({ code, reason, details }: HttpError): ErrorResponse {
	return {
		error: details === undefined ? { code, message: reason } : { code, message: reason, details },
	};
}

export const onError: ErrorHandler = (error, c) => {
	const failure = toHttpError(error);
	if (failure.status >= 500) {
		console.error(`${c.req.method} ${c.req.path} failed`, error);
	}
	return c.json(envelope(failure), failure.status);
};

export const onNotFound: NotFoundHandler = (c) =>
	c.json(envelope(new HttpError("not_found", `No route for ${c.req.method} ${c.req.path}`)), 404);

/**
 * Turns a store's own errors into HTTP ones.
 *
 * The handlers are keyed by tag and the map must cover every tag in the
 * effect's failure type, so a new error class added to a store is a compile
 * error here rather than an unexplained 500 in production.
 */
export const asHttpError =
	<E extends { readonly _tag: string }>(
		status: {
			[Tag in E["_tag"]]: (failure: Extract<E, { readonly _tag: Tag }>) => HttpError;
		},
	) =>
	<A, R>(effect: Effect.Effect<A, E, R>): Effect.Effect<A, HttpError, R> =>
		Effect.mapError(effect, (failure) => {
			const toHttp = status[failure._tag as E["_tag"]];
			return toHttp(failure as Extract<E, { readonly _tag: E["_tag"] }>);
		});
