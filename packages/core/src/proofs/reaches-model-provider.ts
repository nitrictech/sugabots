import { builtInSignInService, providerLacksCredential } from "@sugabots/contracts";
import {
	ModelProviderNotFound,
	ProviderModelNotFound,
	ProviderModelsRequireCredential,
} from "@sugabots/contracts/errors/providers";
import { and, eq } from "drizzle-orm";
import { Effect } from "effect";
import { query } from "../database/database.ts";
import { modelProvider } from "../database/schema.ts";
import { isUuid } from "../ids/ids.ts";
import { providerIn } from "../providers/model-providers/model-provider-reads.ts";
import { defineProof, type Named, type Proof } from "./proof.ts";
import type { CanManageWorkspace } from "./workspace-permissions.ts";

export interface ReachesModelProvider<P, W, V> extends Proof<"ReachesModelProvider", [P, W, V]> {
	readonly canManage: CanManageWorkspace<P, W>;
	readonly provider: Named<V, string>;
}

export interface ReachesProviderModel<P, W, V, M>
	extends Proof<"ReachesProviderModel", [P, W, V, M]> {
	readonly reach: ReachesModelProvider<P, W, V>;
	readonly model: Named<M, string>;
	readonly configured: { readonly source: "manual" | "fetched"; readonly modelId: string };
}

const ReachesModelProviderProof = defineProof("ReachesModelProvider");
const ReachesProviderModelProof = defineProof("ReachesProviderModel");

export const proveReachesModelProvider = <P, W, V>(
	canManage: CanManageWorkspace<P, W>,
	provider: Named<V, string>,
) =>
	Effect.gen(function* () {
		if (!isUuid(provider.value)) return yield* new ModelProviderNotFound();
		const { principal, workspace } = canManage.inWorkspace;
		const [found] = yield* query((db) =>
			db
				.select({ id: modelProvider.id })
				.from(modelProvider)
				.where(
					and(eq(modelProvider.id, provider.value), eq(modelProvider.workspaceId, workspace.value)),
				),
		);
		if (!found) return yield* new ModelProviderNotFound();
		const proof: ReachesModelProvider<P, W, V> = ReachesModelProviderProof.prove(
			[principal, workspace, provider],
			{ canManage, provider },
		);
		return proof;
	});

export const proveReachesProviderModel = <P, W, V, M>(
	reach: ReachesModelProvider<P, W, V>,
	model: Named<M, string>,
) =>
	Effect.gen(function* () {
		const { principal, workspace } = reach.canManage.inWorkspace;
		const provider = yield* providerIn(workspace.value, reach.provider.value);
		if (!provider) return yield* new ModelProviderNotFound();
		if (providerLacksCredential(provider)) {
			return yield* new ProviderModelsRequireCredential({
				missing: builtInSignInService(provider.builtIn) ?? "api-key",
			});
		}
		const configured = provider.models.find((candidate) => candidate.id === model.value);
		if (!configured) return yield* new ProviderModelNotFound();
		const proof: ReachesProviderModel<P, W, V, M> = ReachesProviderModelProof.prove(
			[principal, workspace, reach.provider, model],
			{ reach, model, configured },
		);
		return proof;
	});
