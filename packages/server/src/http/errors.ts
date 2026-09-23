import type { ApiFailure } from "@sugabots/contracts/http";
import { Effect, Schema } from "effect";
import { HttpServerResponse } from "effect/unstable/http";

/**
 * Turns a store's own errors into the API's.
 *
 * The map is keyed by tag and must cover every tag in the effect's failure
 * type, so a new error class added to a store is a compile error here rather
 * than an unexplained 500 in production. The result fails with only what the
 * tags present map to, and those must be errors the endpoint declares, or its
 * handler does not compile.
 */
export const asHttpError =
	// biome-ignore lint/suspicious/noExplicitAny: each entry takes its own tag's error, checked per call.
		<const Status extends Record<string, (failure: any) => ApiFailure>>(status: Status) =>
		<A, E extends { readonly _tag: keyof Status & string }, R>(
			effect: Effect.Effect<A, E, R>,
		): Effect.Effect<A, ReturnType<Status[E["_tag"]]>, R> =>
			Effect.mapError(
				effect,
				(failure) =>
					(status[failure._tag] as Status[E["_tag"]])(failure) as ReturnType<Status[E["_tag"]]>,
			);

/**
 * A failure as a response, for the router-level middleware that answers
 * before any endpoint does and so has no endpoint to encode it.
 */
export function failureResponse<F extends ApiFailure>(
	schema: Schema.Codec<F, unknown>,
	failure: F,
	status: number,
): HttpServerResponse.HttpServerResponse {
	return HttpServerResponse.jsonUnsafe(Schema.encodeSync(schema)(failure), { status });
}
