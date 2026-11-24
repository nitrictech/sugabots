import { connectorsContracts } from "@sugabots/contracts/operations/connectors";
import { Effect } from "effect";
import { proveCanManageProject } from "../../../proofs/project-permissions.ts";
import { named } from "../../../proofs/proof.ts";
import { proveReachesProject } from "../../../proofs/reaches-project.ts";
import { GitHubApps } from "../../../providers/connectors/github/github-app.ts";
import { defineOperation } from "../../operation.ts";

export const installUrl = defineOperation(
	connectorsContracts["gitHubConnectors.installUrl"],
	(principal, input) =>
		Effect.gen(function* () {
			const gitHubApps = yield* GitHubApps.Service;
			return yield* named(principal, input.projectId, (principal, project) =>
				Effect.gen(function* () {
					const canManage = yield* proveCanManageProject(
						yield* proveReachesProject(principal, project),
					);
					const url = yield* gitHubApps.installUrl(canManage, input.connectorId);
					return { url };
				}),
			);
		}),
);
