import { ActionForbidden } from "@sugabots/contracts/errors/proofs";
import { type ApiFailure, Forbidden, NotFound } from "@sugabots/contracts/http";
import { type DomainError, type PublicError, toPublicError, type UserText } from "@sugabots/errors";
import { Effect, Schema, SchemaAST } from "effect";
import { HttpServerResponse } from "effect/unstable/http";

/** One of the API's failure classes, such as `NotFound`. */
type ApiFailureClass = new (fields: {
	readonly message: UserText;
	readonly error?: PublicError;
}) => ApiFailure;

/**
 * Turns a service's own errors into the API's, choosing each one's class, and
 * so its status, by its tag. The response carries the error's `userMessage`,
 * plus its {@link toPublicError} fields for a `DomainError`. Its internal
 * `message` and `cause` never reach a client.
 * Failures already in the API's terms pass through, for a route that answers
 * one refusal itself (with `details`, say).
 *
 * The map is keyed by tag and must cover every tag in the effect's failure
 * type, so a new error class added to a service is a compile error here rather
 * than an unexplained 500 in production. The result fails with only the
 * classes the tags present map to, and those must be failures the endpoint
 * declares, or its handler does not compile.
 */
export const asHttpError =
	<const Statuses extends Record<string, ApiFailureClass>>(statuses: Statuses) =>
	<A, E extends (DomainError & { readonly _tag: keyof Statuses & string }) | ApiFailure, R>(
		effect: Effect.Effect<A, E, R>,
	): Effect.Effect<
		A,
		InstanceType<Statuses[Exclude<E, ApiFailure>["_tag"]]> | Extract<E, ApiFailure>,
		R
	> =>
		Effect.mapError(effect, (failure) => {
			if (!("userMessage" in failure)) return failure as Extract<E, ApiFailure>;
			const Failure = statuses[failure._tag] as Statuses[Exclude<E, ApiFailure>["_tag"]];
			return new Failure({
				message: failure.userMessage,
				error: toPublicError(failure),
			}) as InstanceType<typeof Failure>;
		});

/**
 * How core's refusals are answered, for the `asHttpError` of any endpoint
 * whose operation authorizes. Something the caller cannot reach is `NotFound`,
 * so an id cannot be probed for; something they reach but may not act on is
 * `Forbidden`. `BotCannotReach` is a bot's refusal, which a member's session
 * never meets: the bot's asker reaches what it may not act on.
 */
export const refusals = {
	ResourceHidden: NotFound,
	ActionForbidden: Forbidden,
	BotCannotReach: Forbidden,
};

/**
 * For an operation only a member signed in may call, such as one on their own
 * settings, on an endpoint that declares no refusal: behind `Session` the
 * principal is always a member, so `IsMember`'s refusal there is a defect.
 */
export const memberOnly = <A, E, R>(
	effect: Effect.Effect<A, E | ActionForbidden, R>,
): Effect.Effect<A, Exclude<E, ActionForbidden>, R> =>
	Effect.catchIf<A, E | ActionForbidden, R, ActionForbidden, never, never, never>(
		effect,
		(failure): failure is ActionForbidden => failure instanceof ActionForbidden,
		(refusal) => Effect.die(refusal),
	);

/**
 * A failure as a response, for the router-level middleware that answers
 * before any endpoint does and so has no endpoint to encode it. Its status is
 * the one `schema` declares, as an endpoint's would be.
 */
export function failureResponse<F extends ApiFailure>(
	schema: Schema.Codec<F, unknown>,
	failure: F,
): HttpServerResponse.HttpServerResponse {
	const status = httpApiStatus(schema.ast) ?? INTERNAL_SERVER_ERROR;
	return HttpServerResponse.jsonUnsafe(Schema.encodeSync(schema)(failure), { status });
}

const httpApiStatus = SchemaAST.resolveAt<number>("httpApiStatus");

/** The status the HttpApi gives a failure whose schema declares none. */
const INTERNAL_SERVER_ERROR = 500;
