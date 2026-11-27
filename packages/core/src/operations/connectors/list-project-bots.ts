import { connectorsContracts } from "@sugabots/contracts/operations/connectors";
import { Effect } from "effect";
import { proveCanReadConnectors } from "../../proofs/project-permissions.ts";
import { named } from "../../proofs/proof.ts";
import { proveReachesProject } from "../../proofs/reaches-project.ts";
import { Connectors } from "../../providers/connectors/connectors.ts";
import { defineOperation } from "../operation.ts";

export const listProjectBots = defineOperation(
	connectorsContracts["connectors.listProjectBots"],
	(principal, input) =>
		Effect.gen(function* () {
			const connectors = yield* Connectors.Service;
			return yield* named(principal, input.projectId, (principal, project) =>
				proveReachesProject(principal, project).pipe(
					Effect.flatMap(proveCanReadConnectors),
					Effect.flatMap(connectors.listProjectBots),
				),
			);
		}),
);
