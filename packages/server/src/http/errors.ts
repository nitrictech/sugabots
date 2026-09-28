import type { ApiFailure } from "@sugabots/contracts/http";
import type { UserFacing } from "@sugabots/core/user-message";
import { Effect, Schema } from "effect";
import { HttpServerResponse } from "effect/unstable/http";

/** One of the API's failure classes, such as `NotFound`. */
type ApiFailureClass = new (fields: { readonly message: string }) => ApiFailure;

/**
 * Turns a store's own errors into the API's, choosing each one's class, and
 * so its status, by its tag. The response carries the error's `userMessage`
 * and nothing else, so its internal `message` never reaches a client.
 * Failures already in the API's terms pass through, for a route that answers
 * one refusal itself (with `details`, say).
 *
 * The map is keyed by tag and must cover every tag in the effect's failure
 * type, so a new error class added to a store is a compile error here rather
 * than an unexplained 500 in production. The result fails with only the
 * classes the tags present map to, and those must be failures the endpoint
 * declares, or its handler does not compile.
 */
export const asHttpError =
	<const Statuses extends Record<string, ApiFailureClass>>(statuses: Statuses) =>
	<A, E extends (UserFacing & { readonly _tag: keyof Statuses & string }) | ApiFailure, R>(
		effect: Effect.Effect<A, E, R>,
	): Effect.Effect<
		A,
		InstanceType<Statuses[Exclude<E, ApiFailure>["_tag"]]> | Extract<E, ApiFailure>,
		R
	> =>
		Effect.mapError(effect, (failure) => {
			if (!("userMessage" in failure)) return failure as Extract<E, ApiFailure>;
			const Failure = statuses[failure._tag] as Statuses[Exclude<E, ApiFailure>["_tag"]];
			return new Failure({ message: failure.userMessage }) as InstanceType<typeof Failure>;
		});

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
