import { ResourceHidden } from "@sugabots/contracts/errors/proofs";
import { sql } from "drizzle-orm";
import { Effect } from "effect";
import { automation, workspace } from "../database/schema.ts";
import { isUuid } from "../ids/ids.ts";
import type { Principal } from "../principal.ts";
import { proveInWorkspace } from "./in-workspace.ts";
import { defineProof, type Named, type Proof } from "./proof.ts";
import { projectReachPredicate } from "./reach-set.ts";

export interface ReachesAutomation<P, A> extends Proof<"ReachesAutomation", [P, A]> {
	readonly automation: Named<A, string>;
	readonly workspace: string;
}

const ReachesAutomationProof = defineProof("ReachesAutomation");

export const proveReachesAutomation = <P, W, A>(
	principal: Named<P, Principal>,
	workspaceId: Named<W, string>,
	automationId: Named<A, string>,
) =>
	Effect.gen(function* () {
		const hidden = new ResourceHidden({ resource: "automation" });
		const id = automationId.value;
		if (!isUuid(id)) return yield* hidden;
		const acting = principal.value;
		const source = acting._tag === "WebhookCall" ? acting.source : undefined;
		if (source && (source.kind !== "trigger" || source.automation !== id)) return yield* hidden;
		const reachedProject = source
			? sql`${automation.projectId} = ${source.project}::uuid`
			: projectReachPredicate(acting, automation.projectId);
		const inWorkspace = yield* proveInWorkspace(
			principal,
			workspaceId,
			sql`exists (
				select 1 from ${automation}
				where ${automation.id} = ${id}::uuid and ${automation.workspaceId} = ${workspace.id}
					and ${automation.deletedAt} is null and ${reachedProject}
			)`,
		).pipe(Effect.mapError(() => hidden));
		const proof: ReachesAutomation<P, A> = ReachesAutomationProof.prove([principal, automationId], {
			automation: automationId,
			workspace: inWorkspace.workspace.value,
		});
		return proof;
	});
