import { SearchProviderNotFound } from "@sugabots/contracts/errors/providers";
import { eq } from "drizzle-orm";
import { Effect } from "effect";
import { query } from "../database/database.ts";
import { searchProvider } from "../database/schema.ts";
import { defineProof, type Named, type Proof } from "./proof.ts";
import type { CanManageWorkspace } from "./workspace-permissions.ts";

export interface ReachesSearchProvider<P, W> extends Proof<"ReachesSearchProvider", [P, W]> {
	readonly workspace: Named<W, string>;
	readonly providerId: string;
}

const ReachesSearchProviderProof = defineProof("ReachesSearchProvider");

export const proveReachesSearchProvider = <P, W>(canManage: CanManageWorkspace<P, W>) =>
	Effect.gen(function* () {
		const { principal, workspace } = canManage.inWorkspace;
		const [found] = yield* query((db) =>
			db
				.select({ id: searchProvider.id })
				.from(searchProvider)
				.where(eq(searchProvider.workspaceId, workspace.value)),
		);
		if (!found) return yield* new SearchProviderNotFound();
		const proof: ReachesSearchProvider<P, W> = ReachesSearchProviderProof.prove(
			[principal, workspace],
			{ workspace, providerId: found.id },
		);
		return proof;
	});
