import { ActionForbidden } from "@sugabots/contracts/errors/proofs";
import { Effect } from "effect";
import type { Principal } from "../principal.ts";
import { defineProof, type Named, type Proof } from "./proof.ts";

/**
 * P acts for one member on what is their own, such as the bots pinned in
 * their sidebar: a member signed in, for themselves, or a bot for its asker
 * in member bounds, which a Personal Assistant's own turns have and where its
 * member approves each change. No other principal changes a member's own
 * things.
 */
export interface ActsForMember<P> extends Proof<"ActsForMember", [P]> {
	readonly principal: Named<P, Principal>;
	readonly member: string;
}

const ActsForMemberProof = defineProof("ActsForMember");

export const proveActsForMember = <P>(
	principal: Named<P, Principal>,
): Effect.Effect<ActsForMember<P>, ActionForbidden> => {
	const acting = principal.value;
	const member =
		acting._tag === "MemberSession"
			? acting.member
			: acting._tag === "BotForAsker" && acting.bounds.kind === "member"
				? acting.asker
				: undefined;
	if (member === undefined) return Effect.fail(new ActionForbidden({ proof: "ActsForMember" }));
	const proof: ActsForMember<P> = ActsForMemberProof.prove([principal], { principal, member });
	return Effect.succeed(proof);
};
