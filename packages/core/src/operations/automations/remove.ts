import { automationsContracts } from "@sugabots/contracts/operations/automations";
import { Effect } from "effect";
import { ProjectAutomations } from "../../chats/automations/project-automations.ts";
import { proveCanManageProject } from "../../proofs/project-permissions.ts";
import { named } from "../../proofs/proof.ts";
import { proveReachesProjectAutomation } from "../../proofs/reaches-project-automation.ts";
import { defineOperation } from "../operation.ts";

export const remove = defineOperation(
	automationsContracts["automations.remove"],
	(principal, input) =>
		Effect.gen(function* () {
			const automations = yield* ProjectAutomations.Service;
			return yield* named(principal, input.projectId, input.automationId, (principal, project, automation) =>
				Effect.gen(function* () {
					const { reach, target } = yield* proveReachesProjectAutomation(
						principal,
						project,
						automation,
					);
					const canManage = yield* proveCanManageProject(reach);
					return yield* automations.remove(canManage, automation, target);
				}),
			);
		}),
);
