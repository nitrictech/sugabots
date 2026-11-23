import type { ApiFailure } from "@sugabots/contracts/http";
import { isApiFailure } from "@sugabots/sdk";

/** What a page says when a request it needed never reached the API. */
export const API_DID_NOT_ANSWER = "The API did not answer. Reload this page to try again.";

export class NotReadyError extends Error {
	constructor() {
		super("Workspace not ready");
		this.name = "NotReadyError";
	}
}

/**
 * What to put in front of somebody when a request fails: the API's own
 * message, or the screen's wording for that failure in `instead`, such as
 * what a `Conflict` means where a project is being named. Anything that is
 * not one of the API's failures never reached it, so it gets the one message
 * that is true of all of them.
 */
export function failureMessage(
	failure: unknown,
	instead: Partial<Record<ApiFailure["_tag"], string>> = {},
): string {
	if (failure instanceof NotReadyError) {
		return "Your workspace is not ready yet";
	}
	if (!isApiFailure(failure)) {
		return "Could not reach the API";
	}
	return instead[failure._tag] ?? failure.message;
}
