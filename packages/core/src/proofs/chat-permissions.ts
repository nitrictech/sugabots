import { ActionForbidden } from "@sugabots/contracts/errors/proofs";
import { Effect } from "effect";
import {
	type MemberPlace,
	mayInProjectAs,
	memberActing,
	type ProjectFacts,
	type ReachedAs,
} from "./facts.ts";
import { defineProof, type Proof } from "./proof.ts";
import type { ReachesChat } from "./reaches-chat.ts";
import type { ReachesFile } from "./reaches-file.ts";

/**
 * P may manage the chats of the project X is in, X being one of its chats or
 * a file in one: rename its chats, and delete the files written in them
 * (`project.chats.manage`). In a project members made, its owner and admins;
 * in a bot's default project, the bot's managers who reach it. A bot has its
 * asker's permission there; a run, a webhook call and system work manage
 * nothing. A pure function of the reach proof, by the project grant table.
 */
export interface CanManageChats<P, X> extends Proof<"CanManageChats", [P, X]> {
	/** The member whose permission gave it: a member signed in, or a bot's asker. */
	readonly member: MemberPlace;
}

const CanManageChatsProof = defineProof("CanManageChats");

/**
 * The member whose permissions let `as` rename the project's chats and delete
 * the files written in them, if they do. `CanManageChats`.
 */
export function memberManagingChats(as: ReachedAs, project: ProjectFacts): MemberPlace | undefined {
	const member = memberActing(as);
	return member && mayInProjectAs(member, project, "project.chats.manage") ? member : undefined;
}

export const proveCanManageChats = <P, X>(
	reach: ReachesChat<P, X> | ReachesFile<P, X>,
): Effect.Effect<CanManageChats<P, X>, ActionForbidden> => {
	const member = memberManagingChats(reach.as, reach.project);
	if (!member) {
		return Effect.fail(new ActionForbidden({ proof: "CanManageChats" }));
	}
	const about = reach.kind === "ReachesChat" ? reach.chat : reach.file;
	const proof: CanManageChats<P, X> = CanManageChatsProof.prove([reach.principal, about], {
		member,
	});
	return Effect.succeed(proof);
};
