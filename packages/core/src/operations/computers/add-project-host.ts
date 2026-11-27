import { computersContracts } from "@sugabots/contracts/operations/computers";
import { Effect } from "effect";
import { ComputerNetwork } from "../../computers/computer-network.ts";
import { proveCanChangeAllowedHosts } from "../../proofs/project-permissions.ts";
import { named } from "../../proofs/proof.ts";
import { proveReachesProject } from "../../proofs/reaches-project.ts";
import { defineOperation } from "../operation.ts";

export const addProjectHost = defineOperation(
	computersContracts["projectComputer.addHost"],
	(principal, input) =>
		Effect.gen(function* () {
			const network = yield* ComputerNetwork.Service;
			return yield* named(principal, input.projectId, (principal, project) =>
				Effect.gen(function* () {
					const canChange = yield* proveCanChangeAllowedHosts(
						yield* proveReachesProject(principal, project),
					);
					return yield* network.addProjectHost(canChange, input.host);
				}),
			);
		}),
);
