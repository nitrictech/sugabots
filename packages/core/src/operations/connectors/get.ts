import { connectorsContracts } from "@sugabots/contracts/operations/connectors";
import { Effect } from "effect";
import { proveCanReadConnectors } from "../../proofs/project-permissions.ts";
import { named } from "../../proofs/proof.ts";
import { proveReachesConnector } from "../../proofs/reaches-connector.ts";
import { Connectors } from "../../providers/connectors/connectors.ts";
import { defineOperation } from "../operation.ts";

export const get = defineOperation(connectorsContracts["connectors.get"], (principal, input) =>
	Effect.gen(function* () {
		const connectors = yield* Connectors.Service;
		return yield* named(
			principal,
			input.projectId,
			input.connectorId,
			(principal, project, connector) =>
				Effect.gen(function* () {
					const { reach, target } = yield* proveReachesConnector(principal, project, connector);
					const canRead = yield* proveCanReadConnectors(reach);
					return yield* connectors.get(canRead, connector, target);
				}),
		);
	}),
);
