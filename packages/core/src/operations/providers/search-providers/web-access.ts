import { providersContracts } from "@sugabots/contracts/operations/providers";
import { Effect } from "effect";
import { proveInWorkspace } from "../../../proofs/in-workspace.ts";
import { named } from "../../../proofs/proof.ts";
import { proveCanReadWorkspace } from "../../../proofs/workspace-permissions.ts";
import { SearchProviders } from "../../../providers/search-providers/search-providers.ts";
import { workspaceIdOf } from "../../../workspaces/workspace-reference.ts";
import { defineOperation } from "../../operation.ts";

export const webAccess = defineOperation(
	providersContracts["searchProviders.webAccess"],
	(principal, input) =>
		Effect.gen(function* () {
			const searchProviders = yield* SearchProviders.Service;
			const workspaceId = yield* workspaceIdOf(input.workspace);
			return yield* named(principal, workspaceId, (principal, workspace) =>
				Effect.gen(function* () {
					const canRead = yield* proveCanReadWorkspace(
						yield* proveInWorkspace(principal, workspace),
					);
					return { enabled: yield* searchProviders.webAccess(canRead) };
				}),
			);
		}),
);
