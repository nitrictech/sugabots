import { type ApiErrorCode, apiErrorCodeForStatus, errorResponseSchema } from "@sugabots/contracts";
import { Schema } from "effect";

/** A failed request, decoded from the API's error envelope. */
export class ApiError extends Error {
	readonly code: ApiErrorCode;
	readonly status: number;
	readonly details: unknown;

	constructor(code: ApiErrorCode, message: string, status: number, details?: unknown) {
		super(message);
		this.name = "ApiError";
		this.code = code;
		this.status = status;
		this.details = details;
	}
}

/** The part of a Hono RPC response `unwrap` needs. */
interface JsonResponse<T> {
	readonly ok: boolean;
	readonly status: number;
	json(): Promise<T>;
}

/**
 * Turns a route call into its body, or throws `ApiError`.
 *
 * Hono RPC hands back a `Response`, which leaves every caller to check `ok` and
 * decode the envelope. This does it once:
 *
 * ```ts
 * const me = await unwrap(client.api.me.$get());
 * ```
 *
 */
export async function unwrap<T>(response: JsonResponse<T> | Promise<JsonResponse<T>>): Promise<T> {
	const resolved = await response;
	let body: unknown;
	try {
		body = await resolved.json();
	} catch {
		if (resolved.ok) {
			throw new ApiError(
				"internal",
				"The successful response did not contain valid JSON",
				resolved.status,
			);
		}
	}

	if (resolved.ok) {
		return body as T;
	}

	throw toApiError(body, resolved.status);
}

/** Checks a response from an endpoint that intentionally returns no body. */
export async function unwrapEmpty(
	response: JsonResponse<unknown> | Promise<JsonResponse<unknown>>,
): Promise<void> {
	const resolved = await response;
	if (resolved.ok) {
		return;
	}

	throw toApiError(await resolved.json().catch(() => undefined), resolved.status);
}

/** Reads the envelope if there is one, and falls back to the status. */
export function toApiError(body: unknown, status: number, fallback?: string): ApiError {
	const envelope = Schema.decodeUnknownResult(errorResponseSchema)(body);
	if (envelope._tag === "Success") {
		const { code, message, details } = envelope.success.error;
		return new ApiError(code, message, status, details);
	}

	// Not our envelope: better-auth's own error shape, or a proxy's error page.
	return new ApiError(
		apiErrorCodeForStatus(status),
		fallback ?? `Request failed with status ${status}`,
		status,
	);
}
