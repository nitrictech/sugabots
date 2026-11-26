import { providersContracts } from "@sugabots/contracts/operations/providers";
import { Effect } from "effect";
import { proveReachesSearchProvider } from "../../../proofs/reaches-search-provider.ts";
import { Egress } from "../../../providers/network/egress.ts";
import { SearchProviders } from "../../../providers/search-providers/search-providers.ts";
import { requireAllowedUrl } from "../../../providers/tested-configuration.ts";
import { defineOperation } from "../../operation.ts";
import { managingWorkspace } from "../../workspace-openings.ts";

export const update = defineOperation(
	providersContracts["searchProviders.update"],
	(principal, input) =>
		Effect.gen(function* () {
			const searchProviders = yield* SearchProviders.Service;
			return yield* managingWorkspace(principal, input.workspace, (canManage) =>
				Effect.gen(function* () {
					const { baseUrl } = input.changes;
					// Invalid addresses are refused even before a workspace has a search provider.
					const reach = yield* proveReachesSearchProvider(canManage).pipe(
						Effect.tapError(() =>
							baseUrl
								? Effect.flatMap(Egress.Service, (egress) => requireAllowedUrl(egress, baseUrl))
								: Effect.void,
						),
					);
					return yield* searchProviders.update(reach, input.changes);
				}),
			);
		}),
);
