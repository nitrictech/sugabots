import { automationsContracts } from "@sugabots/contracts/operations/automations";
import { Effect } from "effect";
import { ProjectAutomations } from "../../chats/automations/project-automations.ts";
import { proveCanRestrictBotsProject } from "../../proofs/can-restrict-bot.ts";
import { named } from "../../proofs/proof.ts";
import { proveReachesProject } from "../../proofs/reaches-project.ts";
import { defineOperation } from "../operation.ts";

export const list = defineOperation(automationsContracts["automations.list"], (principal, input) =>
	Effect.gen(function* () {
		const automations = yield* ProjectAutomations.Service;
		return yield* named(principal, input.projectId, (principal, project) =>
			proveReachesProject(principal, project).pipe(
				Effect.flatMap(automations.list),
				// An admin restricting a bot they can't talk to reads its automations as set up.
				Effect.catchTag("ResourceHidden", (hidden) =>
					proveCanRestrictBotsProject(principal, project).pipe(
						Effect.mapError(() => hidden),
						Effect.flatMap(automations.listSetUp),
					),
				),
			),
		);
	}),
);
