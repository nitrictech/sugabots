import { connectorsContracts } from "@sugabots/contracts/operations/connectors";
import { Effect } from "effect";
import { proveCanReadConnectors } from "../../../proofs/project-permissions.ts";
import { named } from "../../../proofs/proof.ts";
import { proveReachesConnector } from "../../../proofs/reaches-connector.ts";
import { GitHubConnectors } from "../../../providers/connectors/github/github-connectors.ts";
import { defineOperation } from "../../operation.ts";

export const repositories = defineOperation(
	connectorsContracts["gitHubConnectors.repositories"],
	(principal, input) =>
		Effect.gen(function* () {
			const gitHubConnectors = yield* GitHubConnectors.Service;
			return yield* named(
				principal,
				input.projectId,
				input.connectorId,
				(principal, project, connector) =>
					Effect.gen(function* () {
						const { reach, target } = yield* proveReachesConnector(principal, project, connector);
						const canRead = yield* proveCanReadConnectors(reach);
						return yield* gitHubConnectors.repositories(canRead, connector, target);
					}),
			);
		}),
);
