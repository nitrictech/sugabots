import { computersContracts } from "@sugabots/contracts/operations/computers";
import { Effect } from "effect";
import { ComputerNetwork } from "../../computers/computer-network.ts";
import { named } from "../../proofs/proof.ts";
import { proveReachesProject } from "../../proofs/reaches-project.ts";
import { defineOperation } from "../operation.ts";

export const projectNetwork = defineOperation(
	computersContracts["projectComputer.network"],
	(principal, input) =>
		Effect.gen(function* () {
			const network = yield* ComputerNetwork.Service;
			return yield* named(principal, input.projectId, (principal, project) =>
				Effect.flatMap(proveReachesProject(principal, project), network.projectSettings),
			);
		}),
);
