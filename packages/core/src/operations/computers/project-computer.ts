import { computersContracts } from "@sugabots/contracts/operations/computers";
import { Effect } from "effect";
import { ProjectComputerSetup } from "../../computers/project-computer-setup.ts";
import { named } from "../../proofs/proof.ts";
import { proveReachesProject } from "../../proofs/reaches-project.ts";
import { defineOperation } from "../operation.ts";

export const projectComputer = defineOperation(
	computersContracts["projectComputer.get"],
	(principal, input) =>
		Effect.gen(function* () {
			const setup = yield* ProjectComputerSetup.Service;
			return yield* named(principal, input.projectId, (principal, project) =>
				Effect.flatMap(proveReachesProject(principal, project), setup.get),
			);
		}),
);
