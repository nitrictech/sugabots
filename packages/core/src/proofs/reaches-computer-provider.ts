import { ResourceHidden } from "@sugabots/contracts/errors/proofs";
import { and, eq } from "drizzle-orm";
import { Effect } from "effect";
import { query } from "../database/database.ts";
import { computerProvider } from "../database/schema.ts";
import { isUuid } from "../ids/ids.ts";
import { defineProof, type Named, type Proof } from "./proof.ts";
import type { CanManageWorkspace } from "./workspace-permissions.ts";

export interface ReachesComputerProvider<P, W, V>
	extends Proof<"ReachesComputerProvider", [P, W, V]> {
	readonly workspace: Named<W, string>;
	readonly provider: Named<V, string>;
}

const ReachesComputerProviderProof = defineProof("ReachesComputerProvider");
const hidden = new ResourceHidden({ resource: "computer provider" });

export const proveReachesComputerProvider = <P, W, V>(
	canManage: CanManageWorkspace<P, W>,
	providerId: Named<V, string>,
) =>
	Effect.gen(function* () {
		const id = providerId.value;
		if (!isUuid(id)) return yield* hidden;
		const { principal, workspace } = canManage.inWorkspace;
		const [found] = yield* query((db) =>
			db
				.select({ id: computerProvider.id })
				.from(computerProvider)
				.where(and(eq(computerProvider.id, id), eq(computerProvider.workspaceId, workspace.value))),
		);
		if (!found) return yield* hidden;
		const target: ReachesComputerProvider<P, W, V> = ReachesComputerProviderProof.prove(
			[principal, workspace, providerId],
			{ workspace, provider: providerId },
		);
		return target;
	});
