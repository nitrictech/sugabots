import { connectorsContracts } from "@sugabots/contracts/operations/connectors";
import { Effect } from "effect";
import { proveCanManageProject } from "../../../proofs/project-permissions.ts";
import { named } from "../../../proofs/proof.ts";
import { proveReachesProject } from "../../../proofs/reaches-project.ts";
import { GitHubConnectors } from "../../../providers/connectors/github/github-connectors.ts";
import { defineOperation } from "../../operation.ts";

export const addRepository = defineOperation(
	connectorsContracts["gitHubConnectors.addRepository"],
	(principal, input) =>
		Effect.gen(function* () {
			const gitHubConnectors = yield* GitHubConnectors.Service;
			return yield* named(principal, input.projectId, (principal, project) =>
				Effect.gen(function* () {
					const canManage = yield* proveCanManageProject(
						yield* proveReachesProject(principal, project),
					);
					return yield* gitHubConnectors.addRepository(
						canManage,
						input.connectorId,
						input.repository,
					);
				}),
			);
		}),
);
