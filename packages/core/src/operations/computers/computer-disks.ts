import { computersContracts } from "@sugabots/contracts/operations/computers";
import { Effect } from "effect";
import { ProjectComputerSetup } from "../../computers/project-computer-setup.ts";
import { proveInWorkspace } from "../../proofs/in-workspace.ts";
import { named } from "../../proofs/proof.ts";
import { proveReachSet } from "../../proofs/reach-set.ts";
import { workspaceIdOf } from "../../workspaces/workspace-reference.ts";
import { defineOperation } from "../operation.ts";

export const computerDisks = defineOperation(
	computersContracts["computerProviders.disks"],
	(principal, input) =>
		Effect.gen(function* () {
			const setup = yield* ProjectComputerSetup.Service;
			const workspaceId = yield* workspaceIdOf(input.workspace);
			return yield* named(principal, workspaceId, (principal, workspace) =>
				Effect.flatMap(proveInWorkspace(principal, workspace), (inWorkspace) =>
					setup.disks(proveReachSet(inWorkspace)),
				),
			);
		}),
);
