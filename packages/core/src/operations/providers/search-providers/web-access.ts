import { providersContracts } from "@sugabots/contracts/operations/providers";
import { Effect } from "effect";
import { SearchProviders } from "../../../providers/search-providers/search-providers.ts";
import { defineOperation } from "../../operation.ts";
import { readingWorkspace } from "../../workspace-openings.ts";

export const webAccess = defineOperation(
	providersContracts["searchProviders.webAccess"],
	(principal, input) =>
		Effect.gen(function* () {
			const searchProviders = yield* SearchProviders.Service;
			return yield* readingWorkspace(principal, input.workspace, (canRead) =>
				Effect.gen(function* () {
					return { enabled: yield* searchProviders.webAccess(canRead) };
				}),
			);
		}),
);
