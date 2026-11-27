import type { AcceptedRun } from "@sugabots/contracts";
import { and, eq, isNull, sql } from "drizzle-orm";
import { DateTime, Effect } from "effect";
import { query, serviceOperations } from "../../database/database.ts";
import { automation, automationTrigger, connector } from "../../database/schema.ts";
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

/**
 * The GitHub triggers of enabled automations run by `event` at `repository`,
 * through `connectorId`, while the connector still has the repository and
 * belongs to the automation's project.
 */
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
					eq(connector.projectId, automation.projectId),
					eq(connector.workspaceId, automation.workspaceId),
					sql`${connector.id}::text = ${automationTrigger.settings}->>'connectorId'`,
					// GitHub's paths ignore case.
					sql`exists (select 1 from jsonb_array_elements(${connector.settings}->'repositories') as kept
						where lower(kept->>'path') = lower(${on.repository}))`,
				),
			)
			.where(
				and(
					eq(automation.workspaceId, on.workspaceId),
					eq(automationTrigger.kind, "github"),
					eq(automation.state, "enabled"),
					isNull(automation.deletedAt),
					sql`lower(${automationTrigger.settings}->>'repository') = lower(${on.repository})`,
					sql`${automationTrigger.settings}->'events' ? ${on.event}`,
				),
			),
	);
