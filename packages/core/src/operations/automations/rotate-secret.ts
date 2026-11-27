import { automationsContracts } from "@sugabots/contracts/operations/automations";
import { Effect } from "effect";
import { ProjectAutomations } from "../../chats/automations/project-automations.ts";
import { proveCanManageProject } from "../../proofs/project-permissions.ts";
import { named } from "../../proofs/proof.ts";
import { proveReachesAutomationTrigger } from "../../proofs/reaches-automation-trigger.ts";
import { writingUnderWorkspaceShare } from "../../proofs/workspace-lock.ts";
import { workspaceOfProject } from "../../workspaces/workspace-reference.ts";
import { defineOperation } from "../operation.ts";

export const rotateSecret = defineOperation(
	automationsContracts["automations.rotateSecret"],
	(principal, input) =>
		Effect.gen(function* () {
			const automations = yield* ProjectAutomations.Service;
			// Proved in the write's transaction, under the workspace's lock shared.
			return yield* writingUnderWorkspaceShare(
				workspaceOfProject(input.projectId),
				"project",
				named(
					principal,
					input.projectId,
					input.automationId,
					input.triggerId,
					(principal, project, automation, trigger) =>
						Effect.gen(function* () {
							const { reach, target } = yield* proveReachesAutomationTrigger(
								principal,
								project,
								automation,
								trigger,
							);
							const canManage = yield* proveCanManageProject(reach);
							const secret = yield* automations.replaceSecret(
								canManage,
								trigger,
								target,
								input.secret,
							);
							return { secret };
						}),
				),
			);
		}),
);
