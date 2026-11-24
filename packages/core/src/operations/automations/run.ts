import { automationsContracts } from "@sugabots/contracts/operations/automations";
import { Effect } from "effect";
import { ProjectAutomations } from "../../chats/automations/project-automations.ts";
import { proveCanRunAutomations } from "../../proofs/project-permissions.ts";
import { named } from "../../proofs/proof.ts";
import { proveReachesProject } from "../../proofs/reaches-project.ts";
import { defineOperation } from "../operation.ts";

export const run = defineOperation(automationsContracts["automations.run"], (principal, input) =>
	Effect.gen(function* () {
		const automations = yield* ProjectAutomations.Service;
		return yield* named(principal, input.projectId, (principal, project) =>
			Effect.gen(function* () {
				const canRun = yield* proveCanRunAutomations(
					yield* proveReachesProject(principal, project),
				);
				return yield* automations.run(canRun, input.automationId, input.requestId);
			}),
		);
	}),
);
