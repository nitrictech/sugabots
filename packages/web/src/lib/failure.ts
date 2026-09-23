import type { ApiErrorCode } from "@sugabots/contracts";
import { ApiError } from "@sugabots/sdk";

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
 * genuinely differs per screen is the `instead` map: a `conflict` means
 * something specific where a pod is being named, and nothing in
 * particular anywhere else.
 *
 * Anything that is not an `ApiError` never reached the API, so it gets the one
 * message that is true of all of them.
 */
export function failureMessage(
	failure: unknown,
	instead: Partial<Record<ApiErrorCode, string>> = {},
): string {
	if (failure instanceof NotReadyError) {
		return "Your workspace is not ready yet";
	}
	if (!(failure instanceof ApiError)) {
		return "Could not reach the API";
	}
	return instead[failure.code] ?? failure.message;
}
