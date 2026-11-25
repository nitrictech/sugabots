import { connectorsContracts } from "@sugabots/contracts/operations/connectors";
import { Effect } from "effect";
import { proveCanRestrictBotsProject } from "../../proofs/can-restrict-bot.ts";
import { proveCanManageProject } from "../../proofs/project-permissions.ts";
import { named } from "../../proofs/proof.ts";
import {
	proveReachesConnector,
	proveRestrictableConnector,
} from "../../proofs/reaches-connector.ts";
import { Connectors } from "../../providers/connectors/connectors.ts";
import { defineOperation } from "../operation.ts";

export const update = defineOperation(
	connectorsContracts["connectors.update"],
	(principal, input) =>
		Effect.gen(function* () {
			const connectors = yield* Connectors.Service;
			return yield* named(
				principal,
				input.projectId,
				input.connectorId,
				(principal, project, connector) =>
					Effect.gen(function* () {
						const { reach, target } = yield* proveReachesConnector(principal, project, connector);
						const canManage = yield* proveCanManageProject(reach);
						return yield* connectors.update(canManage, connector, target, input.changes);
					}).pipe(
						Effect.catchTag("ResourceHidden", (hidden) => {
							if (input.changes.enabled !== false || Object.keys(input.changes).length !== 1) {
								return Effect.fail(hidden);
							}
							return Effect.gen(function* () {
								const canRestrict = yield* proveCanRestrictBotsProject(principal, project);
								const target = yield* proveRestrictableConnector(canRestrict, connector);
								return yield* connectors.switchOff(canRestrict, connector, target);
							}).pipe(Effect.mapError(() => hidden));
						}),
					),
			);
		}),
);
