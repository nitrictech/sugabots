import { connectorsContracts } from "@sugabots/contracts/operations/connectors";
import { Effect } from "effect";
import { proveCanManageProject } from "../../proofs/project-permissions.ts";
import { named } from "../../proofs/proof.ts";
import { proveReachesProject } from "../../proofs/reaches-project.ts";
import { Connectors } from "../../providers/connectors/connectors.ts";
import { defineOperation } from "../operation.ts";

export const testUnsaved = defineOperation(
	connectorsContracts["connectors.testUnsaved"],
	(principal, input) =>
		Effect.gen(function* () {
			const connectors = yield* Connectors.Service;
			const { projectId, ...server } = input;
			return yield* named(principal, projectId, (principal, project) =>
				Effect.gen(function* () {
					const canManage = yield* proveCanManageProject(
						yield* proveReachesProject(principal, project),
					);
					return yield* connectors.testUnsaved(canManage, server);
				}),
			);
		}),
);
