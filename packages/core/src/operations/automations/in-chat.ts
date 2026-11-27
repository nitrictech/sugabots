import type { Automation, AutomationTrigger } from "@sugabots/contracts";
import { automationsContracts } from "@sugabots/contracts/operations/automations";
import { Effect } from "effect";
import { ProjectAutomations } from "../../chats/automations/project-automations.ts";
import { approvalRule, proveApproved, proveApprovedAsResolved } from "../../proofs/approved.ts";
import { automationProject } from "../../proofs/automation-in-turn.ts";
import { proveCanManageProject } from "../../proofs/project-permissions.ts";
import { named } from "../../proofs/proof.ts";
import { proveReachesProject } from "../../proofs/reaches-project.ts";
import { proveReachesProjectAutomation } from "../../proofs/reaches-project-automation.ts";
import { ServerSettings } from "../../server-settings/server-settings.ts";
import { automationsPagePath } from "../../server-settings/web-app-paths.ts";
import { defineOperation } from "../operation.ts";

export const listInChat = defineOperation(
	automationsContracts["automations.listInChat"],
	(principal, input, call) =>
		Effect.gen(function* () {
			const automations = yield* ProjectAutomations.Service;
			const place = yield* automationProject(principal, "read");
			const showAutomation = yield* showAutomationAt(place);
			return yield* named(
				principal,
				place.id,
				call,
				input,
				(principal, project, call, approvedInput) =>
					Effect.gen(function* () {
						const reach = yield* proveReachesProject(principal, project);
						const approved = yield* proveApproved(
							principal,
							call,
							approvalRule("automations.listInChat"),
							approvedInput,
							project,
						);
						const listed = yield* automations.list(reach, approved);
						return { automations: listed.map(showAutomation) };
					}),
			);
		}),
);

export const createWithRoutine = defineOperation(
	automationsContracts["automations.createWithRoutine"],
	(principal, input, call) =>
		Effect.gen(function* () {
			const automations = yield* ProjectAutomations.Service;
			const place = yield* automationProject(principal, "change");
			const showAutomation = yield* showAutomationAt(place);
			return yield* named(
				principal,
				place.id,
				call,
				input,
				(principal, project, call, approvedInput) =>
					Effect.gen(function* () {
						const canManage = yield* proveCanManageProject(
							yield* proveReachesProject(principal, project),
						);
						const approved = yield* proveApproved(
							principal,
							call,
							approvalRule("automations.createWithRoutine"),
							approvedInput,
							project,
						);
						const created = yield* automations.createWithRoutine(
							canManage,
							approved,
							place.timeZone,
						);
						return { automation: showAutomation(created) };
					}),
			);
		}),
);

export const updateInChat = defineOperation(
	automationsContracts["automations.updateInChat"],
	(principal, input, call) =>
		Effect.gen(function* () {
			const automations = yield* ProjectAutomations.Service;
			const place = yield* automationProject(principal, "change");
			const showAutomation = yield* showAutomationAt(place);
			return yield* named(
				principal,
				place.id,
				input.automationId,
				call,
				input,
				(principal, project, automation, call, approvedInput) =>
					Effect.gen(function* () {
						const { reach, target } = yield* proveReachesProjectAutomation(
							principal,
							project,
							automation,
						);
						const canManage = yield* proveCanManageProject(reach);
						const rule = approvalRule("automations.updateInChat");
						const approved =
							approvedInput.value.routineExpression === undefined
								? yield* proveApproved(principal, call, rule, approvedInput, project, automation)
								: yield* proveApprovedAsResolved(
										principal,
										call,
										rule,
										approvedInput,
										{ automationRoutineId: yield* automations.findSoleRoutineId(target) },
										project,
										automation,
									);
						const updated = yield* automations.updateInChat(
							canManage,
							automation,
							target,
							approved,
							place.timeZone,
						);
						return { automation: showAutomation(updated) };
					}),
			);
		}),
);

const showAutomationAt = (place: {
	workspaceSlug: string;
	projectSlug: string;
	botHandle: string | null;
}) =>
	Effect.gen(function* () {
		const { webAppUrl } = yield* ServerSettings.Service;
		const { workspaceSlug, projectSlug, botHandle } = place;
		const settingsPage =
			botHandle === null ? { workspaceSlug, projectSlug } : { workspaceSlug, botHandle };
		return (automation: Automation) => ({
			id: automation.id,
			name: automation.name,
			instructions: automation.instructions,
			when: automation.triggers.map(triggerSummary),
			paused: automation.state === "paused",
			settingsUrl: `${webAppUrl}${automationsPagePath(settingsPage, automation.id)}`,
		});
	});

function triggerSummary(trigger: AutomationTrigger) {
	switch (trigger.kind) {
		case "routine":
			return {
				kind: trigger.kind,
				schedule: trigger.schedule,
				timezone: trigger.timezone,
				nextRunAt: trigger.nextScheduledAt,
			};
		case "webhook":
			return { kind: trigger.kind };
		case "github":
			return { kind: trigger.kind, repository: trigger.repository, events: trigger.events };
	}
}
