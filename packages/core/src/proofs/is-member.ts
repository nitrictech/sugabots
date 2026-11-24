import { ActionForbidden } from "@sugabots/contracts/errors/proofs";
import { Effect } from "effect";
import type { Principal } from "../principal.ts";
import { defineProof, type Named, type Proof } from "./proof.ts";

/**
 * P is a member signed in. Operations only members may do, such as deciding
 * an approval or interrupting a turn, demand it, so no bot does them.
 */
export interface IsMember<P> extends Proof<"IsMember", [P]> {
	readonly principal: Named<P, Principal>;
	readonly member: string;
}

const IsMemberProof = defineProof("IsMember");

export const proveIsMember = <P>(
	principal: Named<P, Principal>,
): Effect.Effect<IsMember<P>, ActionForbidden> => {
	const acting = principal.value;
	if (acting._tag !== "MemberSession") {
		return Effect.fail(new ActionForbidden({ proof: "IsMember" }));
	}
	const proof: IsMember<P> = IsMemberProof.prove([principal], { principal, member: acting.member });
	return Effect.succeed(proof);
};
