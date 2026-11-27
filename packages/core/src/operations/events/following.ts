import { ActionForbidden } from "@sugabots/contracts/errors/proofs";
import { Effect } from "effect";
import type { MemberSession, Principal } from "../../principal.ts";

/**
 * The member signed in who follows a stream, whose session's end or expiry
 * ends it. Only a member follows one: a bot reads its chat through its turn.
 */
export const followerOf = (principal: Principal): Effect.Effect<MemberSession, ActionForbidden> =>
	principal._tag === "MemberSession"
		? Effect.succeed(principal)
		: Effect.fail(new ActionForbidden({ proof: "IsMember" }));
