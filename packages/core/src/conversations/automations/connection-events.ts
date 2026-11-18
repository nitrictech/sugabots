import type { AcceptedRun } from "@sugabots/contracts";
import { and, eq, isNull, sql } from "drizzle-orm";
import { DateTime, Effect } from "effect";
import { query, serviceOperations } from "../../database/database.ts";
import { automation, automationTrigger, bot, connection } from "../../database/schema.ts";
import { makeAcceptTrigger } from "./acceptance.ts";
import type { Automations } from "./automations.ts";

/** Runs of connection automations, for what happened at their connections: `Automations.ConnectionEvents`. */
export const makeConnectionEvents = Effect.gen(function* () {
	const operation = yield* serviceOperations<Automations.ConnectionEventsInterface>(
		"Automations.ConnectionEvents",
	);
	const acceptTrigger = yield* makeAcceptTrigger;

	return {
		accept: ({ workspaceId, connectionId, deliveryId, activity }) =>
			operation(
				"accept",
				Effect.gen(function* () {
					const receivedAt = DateTime.formatIso(yield* DateTime.now);
					const automations = yield* listening({
						workspaceId,
						connectionId,
						repository: activity.repository,
						event: activity.event,
					});
					const accepted = yield* Effect.forEach(automations, (listener) =>
						acceptTrigger({
							workspaceId,
							botId: listener.botId,
							automationId: listener.automationId,
							triggerId: listener.triggerId,
							// A retry of the delivery lands on the run the first started.
							triggerIdentity: deliveryId,
							trigger: {
								kind: "github",
								connectionId,
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
	} satisfies Automations.ConnectionEventsInterface;
});

/**
 * The GitHub triggers of enabled automations run by `event` at `repository`,
 * through `connectionId`, while the connection still has the repository and
 * belongs to the automation's bot.
 */
const listening = (on: {
	workspaceId: string;
	connectionId: string;
	repository: string;
	event: string;
}) =>
	query((db) =>
		db
			.select({
				automationId: automation.id,
				triggerId: automationTrigger.id,
				botId: automation.botId,
			})
			.from(automationTrigger)
			.innerJoin(automation, eq(automation.id, automationTrigger.automationId))
			.innerJoin(
				bot,
				and(eq(bot.id, automation.botId), eq(bot.workspaceId, automation.workspaceId)),
			)
			.innerJoin(
				connection,
				and(
					eq(connection.id, on.connectionId),
					eq(connection.botId, bot.id),
					eq(connection.workspaceId, bot.workspaceId),
					sql`${connection.id}::text = ${automationTrigger.settings}->>'connectionId'`,
					// GitHub's paths ignore case.
					sql`exists (select 1 from jsonb_array_elements(${connection.settings}->'repositories') as kept
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
