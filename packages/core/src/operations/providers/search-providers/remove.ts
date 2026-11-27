import { providersContracts } from "@sugabots/contracts/operations/providers";
import { Effect } from "effect";
import { proveReachesSearchProvider } from "../../../proofs/reaches-search-provider.ts";
import { SearchProviders } from "../../../providers/search-providers/search-providers.ts";
import { defineOperation } from "../../operation.ts";
import { managingWorkspace } from "../../workspace-openings.ts";

export const remove = defineOperation(
	providersContracts["searchProviders.remove"],
	(principal, input) =>
		Effect.gen(function* () {
			const searchProviders = yield* SearchProviders.Service;
			return yield* managingWorkspace(principal, input.workspace, (canManage) =>
				Effect.flatMap(proveReachesSearchProvider(canManage), searchProviders.remove),
			);
		}),
);
