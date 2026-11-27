import { automationsContracts } from "@sugabots/contracts/operations/automations";
import { Effect } from "effect";
import { ProjectAutomations } from "../../chats/automations/project-automations.ts";
import { proveCanRunAutomations } from "../../proofs/project-permissions.ts";
import { named } from "../../proofs/proof.ts";
import { proveReachesProjectAutomation } from "../../proofs/reaches-project-automation.ts";
import { writingUnderWorkspaceShare } from "../../proofs/workspace-lock.ts";
import { workspaceOfProject } from "../../workspaces/workspace-reference.ts";
import { defineOperation } from "../operation.ts";

export const run = defineOperation(automationsContracts["automations.run"], (principal, input) =>
	Effect.gen(function* () {
		const automations = yield* ProjectAutomations.Service;
		return yield* named(
			principal,
			input.projectId,
			input.automationId,
			(principal, project, automation) =>
				// Proved in the transaction that admits the run, under the workspace's
				// lock shared, so a member who lost the right to run it meanwhile
				// starts nothing.
				writingUnderWorkspaceShare(
					workspaceOfProject(project.value),
					"project",
					Effect.gen(function* () {
						const { reach, target } = yield* proveReachesProjectAutomation(
							principal,
							project,
							automation,
						);
						const canRun = yield* proveCanRunAutomations(reach);
						return yield* automations.run(canRun, automation, target, input.requestId);
					}),
				),
		);
	}),
);
