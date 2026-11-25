import { ResourceHidden } from "@sugabots/contracts/errors/proofs";
import { sql } from "drizzle-orm";
import { Effect } from "effect";
import { automation, automationTrigger, project } from "../database/schema.ts";
import { isUuid } from "../ids/ids.ts";
import type { Principal } from "../principal.ts";
import { defineProof, type Named, type Proof } from "./proof.ts";
import { proveReachesProject } from "./reaches-project.ts";

export interface ReachesAutomationTrigger<P, J, T>
	extends Proof<"ReachesAutomationTrigger", [P, J, T]> {
	readonly workspace: string;
	readonly project: Named<J, string>;
	readonly automation: string;
	readonly trigger: Named<T, string>;
}

const ReachesAutomationTriggerProof = defineProof("ReachesAutomationTrigger");
const hidden = new ResourceHidden({ resource: "automation trigger" });

export const proveReachesAutomationTrigger = <P, J, A, T>(
	principal: Named<P, Principal>,
	projectId: Named<J, string>,
	automationId: Named<A, string>,
	triggerId: Named<T, string>,
) =>
	Effect.gen(function* () {
		const id = triggerId.value;
		const parent = automationId.value;
		if (!isUuid(id) || !isUuid(parent)) return yield* hidden;
		const reach = yield* proveReachesProject(
			principal,
			projectId,
			false,
			sql`exists (
				select 1 from ${automationTrigger}
				join ${automation} on ${automation.id} = ${automationTrigger.automationId}
					and ${automation.workspaceId} = ${automationTrigger.workspaceId}
				where ${automationTrigger.id} = ${id}::uuid and ${automation.id} = ${parent}::uuid
					and ${automation.projectId} = ${project.id}
					and ${automation.workspaceId} = ${project.workspaceId} and ${automation.deletedAt} is null
			)`,
		).pipe(Effect.mapError(() => hidden));
		const target: ReachesAutomationTrigger<P, J, T> = ReachesAutomationTriggerProof.prove(
			[principal, projectId, triggerId],
			{ workspace: reach.workspace, project: projectId, automation: parent, trigger: triggerId },
		);
		return { reach, target };
	});
