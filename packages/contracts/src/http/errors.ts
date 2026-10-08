import { PublicError, UserText } from "@sugabots/errors";
import { Schema } from "effect";

/**
 * The API's failures, one class per status.
 *
 * An endpoint lists the ones it can answer with, so a client's error channel
 * names exactly those and a handler failing with one it did not declare does
 * not compile. Each is a tagged error on the wire, `{ "_tag": "NotFound",
 * "message": "…" }`, which is what the generated client decodes back into the
 * class.
 */

/** What went wrong, for people to read. */
const message = UserText.schema;

/**
 * Anything machine-readable behind the message: the fields that failed
 * validation, or the code better-auth refused with.
 */
const details = Schema.optional(Schema.Unknown);

/** The `DomainError` behind the status, when there is one. */
const error = Schema.optional(PublicError);

export class BadRequest extends Schema.TaggedError<BadRequest>()(
	"BadRequest",
	{ message, details, error },
	{ httpApiStatus: 400 },
) {}

export class Unauthorized extends Schema.TaggedError<Unauthorized>()(
	"Unauthorized",
	{ message, details, error },
	{ httpApiStatus: 401 },
) {}

/** The caller can see the thing, and may not do this to it. */
export class Forbidden extends Schema.TaggedError<Forbidden>()(
	"Forbidden",
	{ message, details, error },
	{ httpApiStatus: 403 },
) {}

/**
 * Absent, or hidden from the caller: the API does not tell the two apart, so
 * an id cannot be probed for.
 */
export class NotFound extends Schema.TaggedError<NotFound>()(
	"NotFound",
	{ message, details, error },
	{ httpApiStatus: 404 },
) {}

/**
 * How an endpoint whose use case authorizes refuses: `NotFound` for what the
 * caller cannot reach, `Forbidden` for what they reach but may not do.
 */
export const refused = [NotFound, Forbidden] as const;

export class Conflict extends Schema.TaggedError<Conflict>()(
	"Conflict",
	{ message, details, error },
	{ httpApiStatus: 409 },
) {}

export class PayloadTooLarge extends Schema.TaggedError<PayloadTooLarge>()(
	"PayloadTooLarge",
	{ message, details, error },
	{ httpApiStatus: 413 },
) {}

/** Something went wrong on the server. The message says nothing about what. */
export class InternalServerError extends Schema.TaggedError<InternalServerError>()(
	"InternalServerError",
	{ message, details, error },
	{ httpApiStatus: 500 },
) {}

export type ApiFailure =
	| BadRequest
	| Unauthorized
	| Forbidden
	| NotFound
	| Conflict
	| PayloadTooLarge
	| InternalServerError;
