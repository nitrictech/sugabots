import { computersContracts } from "@sugabots/contracts/operations/computers";
import { Effect } from "effect";
import { ProjectComputerSetup } from "../../computers/project-computer-setup.ts";
import { proveCanManageProject } from "../../proofs/project-permissions.ts";
import { named } from "../../proofs/proof.ts";
import { proveReachesProject } from "../../proofs/reaches-project.ts";
import { defineOperation } from "../operation.ts";

export const resetComputer = defineOperation(
	computersContracts["projectComputer.reset"],
	(principal, input) =>
		Effect.gen(function* () {
			const setup = yield* ProjectComputerSetup.Service;
			return yield* named(principal, input.projectId, (principal, project) =>
				Effect.gen(function* () {
					const canManage = yield* proveCanManageProject(
						yield* proveReachesProject(principal, project),
					);
					return yield* setup.reset(canManage);
				}),
			);
		}),
);
