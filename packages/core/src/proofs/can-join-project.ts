import { ActionForbidden, ResourceHidden } from "@sugabots/contracts/errors/proofs";
import { Effect } from "effect";
import { query } from "../database/database.ts";
import type { Principal } from "../principal.ts";
import {
	decideReach,
	type MemberPlace,
	type ProjectFacts,
	type ReachFacts,
	reachFacts,
	useTurnAdmission,
	whoActs,
} from "./facts.ts";
import { defineProof, type Named, type Proof } from "./proof.ts";
import type { HoldsWorkspaceLock } from "./workspace-lock.ts";

/**
 * P's member may put themselves in the project J: a public project members
 * made, in a workspace they belong to, or one they are in already. A bot, for
 * its asker, may only in member bounds, as this changes who reaches what. A
 * private project they aren't in, or a bot's default project, which nobody
 * joins, is hidden from them. Proved under J's workspace's lock (see
 * `HoldsWorkspaceLock`), so a project made private meanwhile is hidden.
 */
export interface CanJoinProject<P, J> extends Proof<"CanJoinProject", [P, J]> {
	readonly principal: Named<P, Principal>;
	readonly project: Named<J, string>;
	/** J's workspace, which services take from here. */
	readonly workspace: string;
	readonly facts: ProjectFacts;
	/** The member who joins, with their role and whether they are in J already. */
	readonly member: MemberPlace;
}

const CanJoinProjectProof = defineProof("CanJoinProject");

const hidden = new ResourceHidden({ resource: "project" });

/** The member who would join: a member signed in, or a bot's asker in member bounds. */
function joiner(principal: Principal, facts: ReachFacts): MemberPlace | undefined {
	const joinsForThemselves =
		principal._tag === "MemberSession" ||
		(principal._tag === "BotForAsker" &&
			principal.bounds.kind === "member" &&
			principal.workspace === facts.project.workspace);
	return joinsForThemselves ? useTurnAdmission(principal, facts).member : undefined;
}

/** Whether `member` may join the project `facts` describes, or is in it already. */
export function mayJoin(member: MemberPlace, facts: ProjectFacts): boolean {
	if (member.actor.workspaceRole === undefined) return false;
	if (facts.defaultOf !== null) return false;
	return member.inProject || facts.visibility === "public";
}

export const proveCanJoinProject = <P, W, J>(
	lock: HoldsWorkspaceLock<P, W>,
	projectId: Named<J, string>,
) =>
	Effect.gen(function* () {
		const { principal } = lock;
		const acting = principal.value;
		const facts = yield* query((db) => reachFacts(db, projectId.value, whoActs(acting)));
		if (!facts || facts.project.workspace !== lock.workspace.value) {
			return yield* Effect.fail(hidden);
		}
		const member = joiner(acting, facts);
		if (!member) {
			// Anyone else joins nothing: refused where they reach the project, hidden elsewhere.
			const reaches = decideReach(acting, facts, undefined).kind === "reaches";
			return yield* Effect.fail(
				reaches ? new ActionForbidden({ proof: "CanJoinProject" }) : hidden,
			);
		}
		if (!mayJoin(member, facts.project)) return yield* Effect.fail(hidden);
		const proof: CanJoinProject<P, J> = CanJoinProjectProof.prove([principal, projectId], {
			principal,
			project: projectId,
			workspace: facts.project.workspace,
			facts: facts.project,
			member,
		});
		return proof;
	});
