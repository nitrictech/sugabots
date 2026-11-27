import { ResourceHidden } from "@sugabots/contracts/errors/proofs";
import { connectorsContracts } from "@sugabots/contracts/operations/connectors";
import { Effect } from "effect";
import { proveCanManageProject } from "../../proofs/project-permissions.ts";
import { named } from "../../proofs/proof.ts";
import { proveCanSetProjectBotConnector } from "../../proofs/reaches-connector.ts";
import { proveReachesProject } from "../../proofs/reaches-project.ts";
import { underWorkspaceShare } from "../../proofs/workspace-lock.ts";
import { Connectors } from "../../providers/connectors/connectors.ts";
import { workspaceOfProject } from "../../workspaces/workspace-reference.ts";
import { defineOperation } from "../operation.ts";

/**
 * Turns a project bot's own connector on or off there. The manager is proved
 * under the workspace's lock, shared, in the write's transaction, so a
 * manager demoted meanwhile turns nothing on.
 */
export const setOnInProject = defineOperation(
	connectorsContracts["connectors.setOnInProject"],
	(principal, input) =>
		Effect.gen(function* () {
			const connectors = yield* Connectors.Service;
			const workspaceId = yield* workspaceOfProject(input.projectId);
			if (workspaceId === undefined) return yield* new ResourceHidden({ resource: "project" });
			return yield* underWorkspaceShare(
				workspaceId,
				named(principal, input.projectId, input.connectorId, (principal, project, connector) =>
					Effect.gen(function* () {
						const canManage = yield* proveCanManageProject(
							yield* proveReachesProject(principal, project),
						);
						const canSet = yield* proveCanSetProjectBotConnector(canManage, connector);
						return yield* connectors.setOnInProject(canSet, input);
					}),
				),
			);
		}),
);
