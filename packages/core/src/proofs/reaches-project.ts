import { BotCannotReach, ResourceHidden } from "@sugabots/contracts/errors/proofs";
import type { SQL } from "drizzle-orm";
import { Effect } from "effect";
import { query } from "../database/database.ts";
import type { Principal } from "../principal.ts";
import {
	decideReach,
	type ProjectFacts,
	type ReachedAs,
	reachFacts,
	useTurnAdmission,
	whoActs,
} from "./facts.ts";
import { defineProof, type Named, type Proof } from "./proof.ts";

/**
 * P reaches the project J. A bot acting for its asker reaches it within its
 * bounds, when both the asker and the bot do, checked in that order. A run
 * reaches J within its bounds when its bot does. Scheduled system work and
 * webhook calls use proofs for their own targets.
 */
export interface ReachesProject<P, J> extends Proof<"ReachesProject", [P, J]> {
	readonly principal: Named<P, Principal>;
	readonly project: Named<J, string>;
	/** J's workspace, which services take from here. */
	readonly workspace: string;
	readonly facts: ProjectFacts;
	readonly as: ReachedAs;
}

const ReachesProjectProof = defineProof("ReachesProject");

export const proveReachesProject = <P, J>(
	principal: Named<P, Principal>,
	projectId: Named<J, string>,
	forDeletion = false,
	contains?: SQL,
) =>
	Effect.gen(function* () {
		const acting = principal.value;
		if (acting._tag === "WebhookCall") return yield* new ResourceHidden({ resource: "project" });
		const facts = yield* query((db) =>
			reachFacts(db, projectId.value, whoActs(acting), forDeletion, contains),
		);
		if (!facts) return yield* Effect.fail(new ResourceHidden({ resource: "project" }));
		const decision = decideReach(acting, facts, undefined);
		if (decision.kind === "hidden") {
			return yield* Effect.fail(new ResourceHidden({ resource: "project" }));
		}
		if (decision.kind === "botCannotReach") {
			return yield* Effect.fail(new BotCannotReach({ resource: "project" }));
		}
		const proof: ReachesProject<P, J> = ReachesProjectProof.prove([principal, projectId], {
			principal,
			project: projectId,
			workspace: facts.project.workspace,
			facts: useTurnAdmission(acting, facts).project,
			as: decision.as,
		});
		return proof;
	});
