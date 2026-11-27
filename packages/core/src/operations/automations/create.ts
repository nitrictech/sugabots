import { automationsContracts } from "@sugabots/contracts/operations/automations";
import { Effect } from "effect";
import { ProjectAutomations } from "../../chats/automations/project-automations.ts";
import { proveIsMember } from "../../proofs/is-member.ts";
import { proveCanManageProject } from "../../proofs/project-permissions.ts";
import { named } from "../../proofs/proof.ts";
import { proveReachesProject } from "../../proofs/reaches-project.ts";
import { writingUnderWorkspaceShare } from "../../proofs/workspace-lock.ts";
import { workspaceOfProject } from "../../workspaces/workspace-reference.ts";
import { defineOperation } from "../operation.ts";

export const create = defineOperation(
	automationsContracts["automations.create"],
	(principal, input) =>
		Effect.gen(function* () {
			const automations = yield* ProjectAutomations.Service;
			const { projectId, ...automation } = input;
			// Proved in the write's transaction, under the workspace's lock shared.
			return yield* writingUnderWorkspaceShare(
				workspaceOfProject(projectId),
				"project",
				named(principal, projectId, (principal, project) =>
					Effect.gen(function* () {
						const canManage = yield* proveCanManageProject(
							yield* proveReachesProject(principal, project),
						);
						const member = yield* proveIsMember(principal);
						return yield* automations.create(canManage, member, automation);
					}),
				),
			);
		}),
);
