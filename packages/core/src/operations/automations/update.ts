import type { AutomationUpdate } from "@sugabots/contracts";
import { ActionForbidden } from "@sugabots/contracts/errors/proofs";
import { automationsContracts } from "@sugabots/contracts/operations/automations";
import { Effect } from "effect";
import { ProjectAutomations } from "../../chats/automations/project-automations.ts";
import { proveCanRestrictBotsProject } from "../../proofs/can-restrict-bot.ts";
import { proveCanManageProject } from "../../proofs/project-permissions.ts";
import { named } from "../../proofs/proof.ts";
import { proveReachesProject } from "../../proofs/reaches-project.ts";
import { defineOperation } from "../operation.ts";

export const update = defineOperation(
	automationsContracts["automations.update"],
	(principal, input) =>
		Effect.gen(function* () {
			const automations = yield* ProjectAutomations.Service;
			const { automationId, changes } = input;
			return yield* named(principal, input.projectId, (principal, project) =>
				proveReachesProject(principal, project).pipe(
					Effect.flatMap(proveCanManageProject),
					Effect.flatMap((canManage) => automations.update(canManage, automationId, changes)),
					// An admin restricting a bot they can't talk to may only switch its automations off.
					Effect.catchTag("ResourceHidden", (hidden) =>
						proveCanRestrictBotsProject(principal, project).pipe(
							Effect.mapError(() => hidden),
							Effect.flatMap((canRestrict) =>
								Effect.gen(function* () {
									if (!onlySwitchesOff(changes)) {
										return yield* new ActionForbidden({ proof: "CanManageProject" });
									}
									return yield* automations.switchOff(canRestrict, automationId);
								}),
							),
						),
					),
				),
			);
		}),
);

/** Whether `changes` only pause the automation. */
function onlySwitchesOff(changes: AutomationUpdate): boolean {
	return (
		changes.state === "paused" && changes.name === undefined && changes.instructions === undefined
	);
}
