import { automationsContracts } from "@sugabots/contracts/operations/automations";
import { Effect } from "effect";
import { ProjectAutomations } from "../../chats/automations/project-automations.ts";
import { proveCanManageProject } from "../../proofs/project-permissions.ts";
import { named } from "../../proofs/proof.ts";
import { proveReachesAutomationTrigger } from "../../proofs/reaches-automation-trigger.ts";
import { defineOperation } from "../operation.ts";

export const getSecret = defineOperation(
	automationsContracts["automations.getSecret"],
	(principal, input) =>
		Effect.gen(function* () {
			const automations = yield* ProjectAutomations.Service;
			return yield* named(
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
						return yield* automations.currentSecret(canManage, trigger, target);
					}),
			);
		}),
);
