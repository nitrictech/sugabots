import type { AutomationUpdate } from "@sugabots/contracts";
import { automationsContracts } from "@sugabots/contracts/operations/automations";
import { Effect } from "effect";
import { ProjectAutomations } from "../../chats/automations/project-automations.ts";
import { proveCanRestrictBotsProject } from "../../proofs/can-restrict-bot.ts";
import { proveIsMember } from "../../proofs/is-member.ts";
import { proveCanManageProject } from "../../proofs/project-permissions.ts";
import { named } from "../../proofs/proof.ts";
import {
	proveReachesProjectAutomation,
	proveRestrictableAutomation,
} from "../../proofs/reaches-project-automation.ts";
import { defineOperation } from "../operation.ts";

export const update = defineOperation(
	automationsContracts["automations.update"],
	(principal, input) =>
		Effect.gen(function* () {
			const automations = yield* ProjectAutomations.Service;
			const { changes } = input;
			return yield* named(principal, input.projectId, input.automationId, (principal, project, automation) =>
				Effect.gen(function* () {
					const { reach, target } = yield* proveReachesProjectAutomation(
						principal,
						project,
						automation,
					);
					const canManage = yield* proveCanManageProject(reach);
					const member = yield* proveIsMember(principal);
					return yield* automations.update(canManage, automation, target, member, changes);
				}).pipe(
					// An admin restricting a bot they can't talk to may only switch its automations off.
					Effect.catchTag("ResourceHidden", (hidden) => {
						if (!onlySwitchesOff(changes)) return Effect.fail(hidden);
						return Effect.gen(function* () {
							const canRestrict = yield* proveCanRestrictBotsProject(principal, project);
							const target = yield* proveRestrictableAutomation(canRestrict, automation);
							return yield* automations.switchOff(canRestrict, automation, target);
						}).pipe(Effect.mapError(() => hidden));
					}),
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
