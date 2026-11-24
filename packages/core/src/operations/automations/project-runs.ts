import { automationsContracts } from "@sugabots/contracts/operations/automations";
import { Effect } from "effect";
import { ProjectAutomations } from "../../chats/automations/project-automations.ts";
import { named } from "../../proofs/proof.ts";
import { proveReachesProject } from "../../proofs/reaches-project.ts";
import { defineOperation } from "../operation.ts";

export const projectRuns = defineOperation(
	automationsContracts["automations.projectRuns"],
	(principal, input) =>
		Effect.gen(function* () {
			const automations = yield* ProjectAutomations.Service;
			const { projectId, ...page } = input;
			return yield* named(principal, projectId, (principal, project) =>
				Effect.flatMap(proveReachesProject(principal, project), (reach) =>
					automations.projectRuns(reach, page),
				),
			);
		}),
);
