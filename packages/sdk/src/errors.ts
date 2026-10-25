import {
	type ApiFailure,
	BadRequest,
	Conflict,
	Forbidden,
	InternalServerError,
	NotFound,
	PayloadTooLarge,
	Unauthorized,
} from "@sugabots/contracts/http";
import { type UserText, userText } from "@sugabots/errors";
import { Schema } from "effect";

const failureSchema = Schema.Union([
	BadRequest,
	Unauthorized,
	Forbidden,
	NotFound,
	Conflict,
	PayloadTooLarge,
	InternalServerError,
]);

/** Whether `failure` is the API answering, rather than a request that never got there. */
export const isApiFailure = Schema.is(failureSchema);

/**
 * The failure a status means, for the parts of the API the generated client
 * does not decode: better-auth's routes, and the event streams.
 */
export function failureForStatus(status: number, message: UserText, details?: unknown): ApiFailure {
	const fields = { message, details };
	switch (status) {
		case 400:
			return new BadRequest(fields);
		case 401:
			return new Unauthorized(fields);
		case 403:
			return new Forbidden(fields);
		case 404:
			return new NotFound(fields);
		case 409:
			return new Conflict(fields);
		case 413:
			return new PayloadTooLarge(fields);
		default:
			return status >= 500 ? new InternalServerError(fields) : new BadRequest(fields);
	}
}

/** The API's own failure if `body` is one, or the one its status means. */
export function failureFromResponse(body: unknown, status: number): ApiFailure {
	const decoded = Schema.decodeUnknownResult(failureSchema)(body);
	if (decoded._tag === "Success") {
		return decoded.success;
	}
	// Not ours: a proxy's error page, or a body that never arrived.
	return failureForStatus(status, refusedBeforeTheApi(status));
}

/** What a refusal that never reached the API means, for the person who made the request. */
function refusedBeforeTheApi(status: number): UserText {
	// The API says when something is over its own limits, so a bare 413 is
	// the web server in front of it, such as nginx at its 1 MB default.
	if (status === 413) {
		return userText`Too large for this server to accept. Whoever runs your Sugabots can raise the upload limit on the web server in front of it`;
	}
	return userText`Request failed with status ${status}`;
}
