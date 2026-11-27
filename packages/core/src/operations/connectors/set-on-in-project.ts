import { connectorsContracts } from "@sugabots/contracts/operations/connectors";
import { Effect } from "effect";
import { proveCanManageProject } from "../../proofs/project-permissions.ts";
import { named } from "../../proofs/proof.ts";
import { proveCanSetProjectBotConnector } from "../../proofs/reaches-connector.ts";
import { proveReachesProject } from "../../proofs/reaches-project.ts";
import { Connectors } from "../../providers/connectors/connectors.ts";
import { defineOperation } from "../operation.ts";

export const setOnInProject = defineOperation(
	connectorsContracts["connectors.setOnInProject"],
	(principal, input) =>
		Effect.gen(function* () {
			const connectors = yield* Connectors.Service;
			return yield* named(
				principal,
				input.projectId,
				input.connectorId,
				(principal, project, connector) =>
					Effect.gen(function* () {
						const canManage = yield* proveCanManageProject(
							yield* proveReachesProject(principal, project),
						);
						const canSet = yield* proveCanSetProjectBotConnector(canManage, connector);
						return yield* connectors.setOnInProject(canSet, input.on);
					}),
			);
		}),
);
