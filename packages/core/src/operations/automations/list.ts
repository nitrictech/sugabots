import { automationsContracts } from "@sugabots/contracts/operations/automations";
import { Effect } from "effect";
import { ProjectAutomations } from "../../chats/automations/project-automations.ts";
import { approvalRule, proveApproved } from "../../proofs/approved.ts";
import { proveCanRestrictBotsProject } from "../../proofs/can-restrict-bot.ts";
import { named } from "../../proofs/proof.ts";
import { proveReachesProject } from "../../proofs/reaches-project.ts";
import { defineOperation } from "../operation.ts";

export const list = defineOperation(
	automationsContracts["automations.list"],
	(principal, input, call) =>
		Effect.gen(function* () {
			const automations = yield* ProjectAutomations.Service;
			return yield* named(
				principal,
				input.projectId,
				call,
				input,
				(principal, project, call, approvedInput) =>
					proveReachesProject(principal, project).pipe(
						Effect.flatMap((reach) =>
							Effect.flatMap(
								proveApproved(
									principal,
									call,
									approvalRule("automations.list"),
									approvedInput,
									project,
								),
								(approved) => automations.list(reach, approved),
							),
						),
						// An admin restricting a bot they can't talk to sees only names and states.
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
