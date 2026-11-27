import { providersContracts } from "@sugabots/contracts/operations/providers";
import { Effect } from "effect";
import { SearchProviders } from "../../../providers/search-providers/search-providers.ts";
import { defineOperation } from "../../operation.ts";
import { managingWorkspace } from "../../workspace-openings.ts";

export const replace = defineOperation(
	providersContracts["searchProviders.replace"],
	(principal, input) =>
		Effect.gen(function* () {
			const searchProviders = yield* SearchProviders.Service;
			const { workspace: reference, ...provider } = input;
			return yield* managingWorkspace(principal, reference, (canManage) =>
				searchProviders.replace(canManage, provider),
			);
		}),
);
