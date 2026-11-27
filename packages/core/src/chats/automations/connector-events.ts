import type { AcceptedRun } from "@sugabots/contracts";
import { and, eq, isNull, or, sql } from "drizzle-orm";
import { alias } from "drizzle-orm/pg-core";
import { DateTime, Effect } from "effect";
import { query, serviceOperations } from "../../database/database.ts";
import {
	automation,
	automationTrigger,
	bot,
	botMember,
	connector,
	project,
	projectMember,
} from "../../database/schema.ts";
import { makeAcceptTrigger } from "./acceptance.ts";
import type { Automations } from "./automations.ts";

/** Runs of connector automations, for what happened at their connectors: `Automations.ConnectorEvents`. */
export const makeConnectorEvents = Effect.gen(function* () {
	const operation = yield* serviceOperations<Automations.ConnectorEventsInterface>(
		"Automations.ConnectorEvents",
	);
	const acceptTrigger = yield* makeAcceptTrigger;

	return {
		accept: (signed, { deliveryId, activity }) =>
			operation(
				"accept",
				Effect.gen(function* () {
					const workspaceId = signed.workspace;
					const connectorId = signed.connector.value;
					const receivedAt = DateTime.formatIso(yield* DateTime.now);
					const triggers = yield* triggersFor({
						workspaceId,
						connectorId,
						repository: activity.repository,
						event: activity.event,
					});
					const accepted = yield* Effect.forEach(triggers, (trigger) =>
						acceptTrigger({
							workspaceId,
							projectId: trigger.projectId,
							automationId: trigger.automationId,
							triggerId: trigger.triggerId,
							// A retry of the delivery lands on the run the first started.
							triggerIdentity: deliveryId,
							trigger: {
								kind: "github",
								connectorId,
								receivedAt,
								deliveryId,
								...activity,
							},
						}).pipe(
							Effect.map((execution): AcceptedRun[] => [execution]),
							// Paused, removed or changed since it was found.
							Effect.catchTags({
								AutomationNotFound: () => Effect.succeed([]),
								AutomationTriggerRejected: () => Effect.succeed([]),
								AutomationTriggerConflict: () => Effect.succeed([]),
							}),
						),
					);
					return accepted.flat();
				}),
			),
	} satisfies Automations.ConnectorEventsInterface;
});

const automationBot = alias(bot, "automation_bot");
const appProject = alias(project, "app_project");
const appBot = alias(bot, "app_bot");

/** A migrated trigger can send repository activity only to members who can reach its app. */
const canDeliverToMigratedTrigger = and(
	eq(automationTrigger.migratedGitHubConnectorId, connector.id),
	eq(appProject.deleting, false),
	or(
		and(
			eq(automationBot.visibility, "personal"),
			eq(appBot.visibility, "personal"),
			eq(automationBot.createdById, appBot.createdById),
		),
		and(
			isNull(appProject.defaultOfBotId),
			eq(automationBot.visibility, "private"),
			sql`not exists (
				select 1 from ${botMember}
				where ${botMember.botId} = ${automationBot.id}
					and not exists (
						select 1 from ${projectMember}
						where ${projectMember.projectId} = ${appProject.id}
							and ${projectMember.memberId} = ${botMember.memberId}
					)
			)`,
		),
	),
);

/** triggersFor finds enabled GitHub triggers for the app, repository and event in `on`. */
const triggersFor = (on: {
	workspaceId: string;
	connectorId: string;
	repository: string;
	event: string;
}) =>
	query((db) =>
		db
			.select({
				automationId: automation.id,
				triggerId: automationTrigger.id,
				projectId: automation.projectId,
			})
			.from(automationTrigger)
			.innerJoin(automation, eq(automation.id, automationTrigger.automationId))
			.innerJoin(
				connector,
				and(
					eq(connector.id, on.connectorId),
					eq(connector.workspaceId, automation.workspaceId),
					sql`${connector.id}::text = ${automationTrigger.settings}->>'connectorId'`,
					// GitHub's paths ignore case.
					sql`exists (select 1 from jsonb_array_elements(${connector.settings}->'repositories') as kept
						where lower(kept->>'path') = lower(${on.repository}))`,
				),
			)
			.innerJoin(project, eq(project.id, automation.projectId))
			.leftJoin(automationBot, eq(automationBot.id, project.defaultOfBotId))
			.innerJoin(appProject, eq(appProject.id, connector.projectId))
			.leftJoin(appBot, eq(appBot.id, appProject.defaultOfBotId))
			.where(
				and(
					or(eq(connector.projectId, automation.projectId), canDeliverToMigratedTrigger),
					eq(automation.workspaceId, on.workspaceId),
					eq(automationTrigger.kind, "github"),
					eq(automation.state, "enabled"),
					isNull(automation.deletedAt),
					sql`lower(${automationTrigger.settings}->>'repository') = lower(${on.repository})`,
					sql`${automationTrigger.settings}->'events' ? ${on.event}`,
				),
			),
	);
