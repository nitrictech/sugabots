import { connectorsContracts } from "@sugabots/contracts/operations/connectors";
import { Effect } from "effect";
import { proveCanReadConnectors } from "../../proofs/project-permissions.ts";
import { named } from "../../proofs/proof.ts";
import { proveReachesProject } from "../../proofs/reaches-project.ts";
import { Connectors } from "../../providers/connectors/connectors.ts";
import { defineOperation } from "../operation.ts";

export const get = defineOperation(connectorsContracts["connectors.get"], (principal, input) =>
	Effect.gen(function* () {
		const connectors = yield* Connectors.Service;
		return yield* named(principal, input.projectId, (principal, project) =>
			Effect.gen(function* () {
				const canRead = yield* proveCanReadConnectors(
					yield* proveReachesProject(principal, project),
				);
				return yield* connectors.get(canRead, input.connectorId);
			}),
		);
	}),
);
