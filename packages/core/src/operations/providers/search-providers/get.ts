import { providersContracts } from "@sugabots/contracts/operations/providers";
import { Effect } from "effect";
import { SearchProviders } from "../../../providers/search-providers/search-providers.ts";
import { defineOperation } from "../../operation.ts";
import { managingWorkspace } from "../../workspace-openings.ts";

export const get = defineOperation(providersContracts["searchProviders.get"], (principal, input) =>
	Effect.gen(function* () {
		const searchProviders = yield* SearchProviders.Service;
		return yield* managingWorkspace(principal, input.workspace, (canManage) =>
			Effect.gen(function* () {
				const provider = yield* searchProviders.get(canManage);
				return { provider: provider ?? null };
			}),
		);
	}),
);
