import { connectorsContracts } from "@sugabots/contracts/operations/connectors";
import { Effect } from "effect";
import { proveCanManageProject } from "../../../proofs/project-permissions.ts";
import { named } from "../../../proofs/proof.ts";
import { proveReachesConnector } from "../../../proofs/reaches-connector.ts";
import { GitHubApps } from "../../../providers/connectors/github/github-app.ts";
import { defineOperation } from "../../operation.ts";

export const installUrl = defineOperation(
	connectorsContracts["gitHubConnectors.installUrl"],
	(principal, input) =>
		Effect.gen(function* () {
			const gitHubApps = yield* GitHubApps.Service;
			return yield* named(
				principal,
				input.projectId,
				input.connectorId,
				(principal, project, connector) =>
					Effect.gen(function* () {
						const { reach, target } = yield* proveReachesConnector(principal, project, connector);
						const canManage = yield* proveCanManageProject(reach);
						const url = yield* gitHubApps.installUrl(canManage, connector, target);
						return { url };
					}),
			);
		}),
);
