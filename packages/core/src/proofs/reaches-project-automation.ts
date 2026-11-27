import { ResourceHidden } from "@sugabots/contracts/errors/proofs";
import { and, eq, isNull, sql } from "drizzle-orm";
import { Effect } from "effect";
import { query } from "../database/database.ts";
import { automation, project } from "../database/schema.ts";
import { isUuid } from "../ids/ids.ts";
import type { Principal } from "../principal.ts";
import type { CanRestrictBotsProject } from "./can-restrict-bot.ts";
import { defineProof, type Named, type Proof } from "./proof.ts";
import { proveReachesProject } from "./reaches-project.ts";

export interface ReachesProjectAutomation<P, J, A>
	extends Proof<"ReachesProjectAutomation", [P, J, A]> {
	readonly workspace: string;
	readonly project: Named<J, string>;
	readonly automation: Named<A, string>;
}

export interface CanSwitchOffAutomation<P, J, A>
	extends Proof<"CanSwitchOffAutomation", [P, J, A]> {
	readonly workspace: string;
	readonly project: Named<J, string>;
	readonly automation: Named<A, string>;
}

const ReachesProjectAutomationProof = defineProof("ReachesProjectAutomation");
const CanSwitchOffAutomationProof = defineProof("CanSwitchOffAutomation");
const hidden = new ResourceHidden({ resource: "automation" });

export const proveReachesProjectAutomation = <P, J, A>(
	principal: Named<P, Principal>,
	projectId: Named<J, string>,
	automationId: Named<A, string>,
) =>
	Effect.gen(function* () {
		const id = automationId.value;
		if (!isUuid(id)) return yield* hidden;
		const reach = yield* proveReachesProject(
			principal,
			projectId,
			false,
			sql`exists (select 1 from ${automation}
				where ${automation.id} = ${id}::uuid and ${automation.projectId} = ${project.id}
				and ${automation.workspaceId} = ${project.workspaceId} and ${automation.deletedAt} is null)`,
		).pipe(Effect.mapError(() => hidden));
		const target: ReachesProjectAutomation<P, J, A> = ReachesProjectAutomationProof.prove(
			[principal, projectId, automationId],
			{ workspace: reach.workspace, project: projectId, automation: automationId },
		);
		return { reach, target };
	});

export const proveRestrictableAutomation = <P, J, A>(
	canRestrict: CanRestrictBotsProject<P, J>,
	automationId: Named<A, string>,
) =>
	Effect.gen(function* () {
		const id = automationId.value;
		if (!isUuid(id)) return yield* hidden;
		const [found] = yield* query((db) =>
			db
				.select({ id: automation.id })
				.from(automation)
				.where(
					and(
						eq(automation.id, id),
						eq(automation.projectId, canRestrict.project.value),
						eq(automation.workspaceId, canRestrict.workspace),
						isNull(automation.deletedAt),
					),
				),
		);
		if (!found) return yield* hidden;
		const target: CanSwitchOffAutomation<P, J, A> = CanSwitchOffAutomationProof.prove(
			[canRestrict.principal, canRestrict.project, automationId],
			{ workspace: canRestrict.workspace, project: canRestrict.project, automation: automationId },
		);
		return target;
	});
