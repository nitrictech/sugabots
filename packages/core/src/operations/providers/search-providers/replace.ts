import { providersContracts } from "@sugabots/contracts/operations/providers";
import { Effect } from "effect";
import { proveInWorkspace } from "../../../proofs/in-workspace.ts";
import { named } from "../../../proofs/proof.ts";
import { proveCanManageWorkspace } from "../../../proofs/workspace-permissions.ts";
import { SearchProviders } from "../../../providers/search-providers/search-providers.ts";
import { workspaceIdOf } from "../../../workspaces/workspace-reference.ts";
import { defineOperation } from "../../operation.ts";

export const replace = defineOperation(
	providersContracts["searchProviders.replace"],
	(principal, input) =>
		Effect.gen(function* () {
			const searchProviders = yield* SearchProviders.Service;
			const { workspace: reference, ...provider } = input;
			const workspaceId = yield* workspaceIdOf(reference);
			return yield* named(principal, workspaceId, (principal, workspace) =>
				Effect.gen(function* () {
					const canManage = yield* proveCanManageWorkspace(
						yield* proveInWorkspace(principal, workspace),
					);
					return yield* searchProviders.replace(canManage, provider);
				}),
			);
		}),
);
