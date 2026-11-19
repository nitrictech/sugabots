export * as CurrentActor from "./current-actor.ts";

import { userText } from "@sugabots/errors";
import { type Brand, Context, Data, Effect } from "effect";
import type { UserFacing } from "../user-message.ts";

/**
 * Who is asking: the person an entry point authenticated.
 *
 * Each entry point proves who is calling in its own way and provides this
 * for the work it runs, so core asks it for the caller instead of trusting an
 * id handed in with the request. There is no default: an operation that needs
 * a caller cannot run where nobody provided one.
 */
export interface Interface {
	readonly userId: AuthenticatedUserId;
}

/**
 * The id of a person an entry point authenticated. Nothing in a request
 * produces one: an id arriving with it is a plain `string`, so it cannot be
 * handed to {@link provide}.
 */
export type AuthenticatedUserId = Brand.Branded<string, "AuthenticatedUserId">;

export const AuthenticatedUserId = {
	/**
	 * Vouches that `userId` is who is calling. Only an entry point that proved
	 * it, such as a session check, calls this, and the development seed and
	 * test helpers stand in for one; each use is a claim for review to check.
	 */
	vouchedFor: (userId: string) => userId as AuthenticatedUserId,
};

/**
 * Required by operations from their callers rather than when they are built,
 * because it is different for every request.
 *
 * @effect-leakable-service
 */
export class Service extends Context.Service<Service, Interface>()("@sugabots/core/CurrentActor") {}

/** Runs an effect as the person `userId`. */
export const provide = (userId: AuthenticatedUserId) =>
	Effect.provideService(Service, Service.of({ userId }));

/**
 * Runs `work`, which a bot does in a turn, as the person the turn answers,
 * `askedBy`. They signed in to post the message the turn answers, which is
 * the claim `vouchedFor` makes. Fails with `NobodyAsked` when the turn answers
 * no person, such as an automation's run.
 */
export const asAsker = <A, E, R>(
	askedBy: string | null | undefined,
	work: Effect.Effect<A, E, R>,
): Effect.Effect<A, E | NobodyAsked, Exclude<R, Service>> =>
	askedBy
		? work.pipe(provide(AuthenticatedUserId.vouchedFor(askedBy)))
		: Effect.fail(new NobodyAsked());

export class NobodyAsked extends Data.TaggedError("NobodyAsked") implements UserFacing {
	get userMessage() {
		return userText`Only a person can ask a bot to do this, and this turn answers no one.`;
	}
}
