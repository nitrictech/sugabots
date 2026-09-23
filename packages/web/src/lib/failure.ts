import type { ApiFailure } from "@sugabots/contracts/http";
import { isApiFailure } from "@sugabots/sdk";

export class NotReadyError extends Error {
	constructor() {
		super("Workspace not ready");
		this.name = "NotReadyError";
	}
}

/**
 * What to put in front of somebody when a request fails.
 *
 * Every screen needs this and each was writing its own `describe(failure)`,
 * three of them with the same name and different behaviour. The wording that
 * genuinely differs per screen is the `instead` map: a `Conflict` means
 * something specific where a pod is being named, and nothing in
 * particular anywhere else.
 *
 * Anything that is not one of the API's failures never reached it, so it gets the one
 * message that is true of all of them.
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
