export * as SystemWorkAuthentication from "./system-work.ts";

import { type DomainError, userText } from "@sugabots/errors";
import { and, eq, isNotNull, isNull, lte, sql } from "drizzle-orm";
import { Context, Effect, ErrorReporter, Layer, Schema } from "effect";
import { AutomationStore } from "../chats/automations/store.ts";
import { query, serviceOperations } from "../database/database.ts";
import {
	automation,
	automationRun,
	automationTrigger,
	computer,
	message,
	placedChat,
} from "../database/schema.ts";
import { isUuid } from "../ids/ids.ts";
import { authenticated, type SystemWork } from "../principal.ts";
import { processLayer, Tier } from "../tiers.ts";

/**
 * The authenticator for work Sugabots does on its own, which the scheduler and
 * the bot loop start from a stored request: each checks the database still
 * holds the work it names, and the principal it builds reaches only that.
 *
 * Only the bot loop and the scheduler may import this, as it takes nothing
 * but stored ids.
 */
export interface Interface {
	/** Compacting a chat, as the stored compaction request asks. */
	readonly compaction: (request: CompactionRequest) => Effect.Effect<SystemWork, StoredWorkGone>;
	/** Putting the computer `computerId` to sleep. */
	readonly computerSleep: (computerId: string) => Effect.Effect<SystemWork, StoredWorkGone>;
	/** Running the automation whose routine `triggerId` fell due. */
	readonly dueRoutine: (triggerId: string) => Effect.Effect<SystemWork, StoredWorkGone>;
	/** Pausing the automation `automationId`, whose last runs all failed. */
	readonly pauseAfterFailures: (automationId: string) => Effect.Effect<SystemWork, StoredWorkGone>;
}

export class Service extends Context.Service<Service, Interface>()(
	"@sugabots/core/SystemWorkAuthentication",
) {
	declare readonly [Tier]: "process";
}

/** A compaction request, as its workflow stored it. */
export interface CompactionRequest {
	readonly chatId: string;
	/** The bot whose turn filled the chat past the compaction line. */
	readonly botId: string;
	/** That turn's reply. */
	readonly sourceMessageId: string;
}

export const make = Effect.gen(function* () {
	const operation = yield* serviceOperations<Interface>("SystemWorkAuthentication");

	return Service.of({
		compaction: (request) =>
			operation(
				"compaction",
				Effect.gen(function* () {
					const ids = [request.chatId, request.botId, request.sourceMessageId];
					const [row] = ids.every(isUuid)
						? yield* query((db) =>
								db
									.select({ workspace: placedChat.workspaceId })
									.from(message)
									.innerJoin(placedChat, eq(placedChat.id, message.chatId))
									.where(
										and(
											eq(message.id, request.sourceMessageId),
											eq(message.chatId, request.chatId),
											eq(message.authorBotId, request.botId),
										),
									)
									.limit(1),
							)
						: [];
					if (!row) return yield* new StoredWorkGone({ work: "compaction" });
					return authenticated.systemWork({
						workspace: row.workspace,
						work: { kind: "compaction", chat: request.chatId },
					});
				}),
			),

		computerSleep: (computerId) =>
			operation(
				"computerSleep",
				Effect.gen(function* () {
					const [row] = isUuid(computerId)
						? yield* query((db) =>
								db
									.select({ workspace: computer.workspaceId, project: computer.projectId })
									.from(computer)
									.where(eq(computer.id, computerId))
									.limit(1),
							)
						: [];
					if (!row) return yield* new StoredWorkGone({ work: "computerSleep" });
					return authenticated.systemWork({
						workspace: row.workspace,
						work: { kind: "computerSleep", computer: computerId, project: row.project },
					});
				}),
			),

		dueRoutine: (triggerId) =>
			operation(
				"dueRoutine",
				Effect.gen(function* () {
					const [row] = isUuid(triggerId)
						? yield* query((db) =>
								db
									.select({
										workspace: automation.workspaceId,
										project: automation.projectId,
										automation: automation.id,
									})
									.from(automationTrigger)
									.innerJoin(automation, eq(automation.id, automationTrigger.automationId))
									.where(
										and(
											eq(automationTrigger.id, triggerId),
											eq(automationTrigger.kind, "routine"),
											isNotNull(automationTrigger.nextScheduledAt),
											lte(automationTrigger.nextScheduledAt, sql`now()`),
											eq(automation.state, "enabled"),
											isNull(automation.deletedAt),
										),
									)
									.limit(1),
							)
						: [];
					if (!row) return yield* new StoredWorkGone({ work: "dueRoutine" });
					return authenticated.systemWork({
						workspace: row.workspace,
						work: {
							kind: "dueRoutine",
							automation: row.automation,
							trigger: triggerId,
							project: row.project,
						},
					});
				}),
			),

		pauseAfterFailures: (automationId) =>
			operation(
				"pauseAfterFailures",
				Effect.gen(function* () {
					const [row] = isUuid(automationId)
						? yield* query((db) =>
								db
									.select({ workspace: automation.workspaceId, project: automation.projectId })
									.from(automation)
									.where(
										and(
											eq(automation.id, automationId),
											eq(automation.state, "enabled"),
											isNull(automation.deletedAt),
											sql`(
												select count(*) from (
													select ${automationRun.state} as state from ${automationRun}
													where ${automationRun.automationId} = ${automationId}
														and ${automationRun.finishedAt} is not null
													order by ${automationRun.acceptedAt} desc, ${automationRun.id} desc
													limit ${AutomationStore.FAILURES_THAT_PAUSE}
												) as latest
												where latest.state = 'failed'
											) = ${AutomationStore.FAILURES_THAT_PAUSE}`,
										),
									)
									.limit(1),
							)
						: [];
					if (!row) return yield* new StoredWorkGone({ work: "pauseAfterFailures" });
					return authenticated.systemWork({
						workspace: row.workspace,
						work: { kind: "pauseAfterFailures", automation: automationId, project: row.project },
					});
				}),
			),
	});
});

export const layerNoDeps = processLayer(Layer.effect(Service, make));

export const layer = layerNoDeps;

/** The stored work is no longer there to do: its rows are gone, or it no longer falls due. */
export class StoredWorkGone
	extends Schema.TaggedError<StoredWorkGone>()("StoredWorkGone", {
		work: Schema.Literals(["compaction", "computerSleep", "dueRoutine", "pauseAfterFailures"]),
	})
	implements DomainError
{
	readonly isRetryable = false;
	override readonly [ErrorReporter.severity] = "Info" as const;
	override get message() {
		return `The stored ${this.work} work is no longer there to do`;
	}
	get userMessage() {
		return userText`This work is no longer needed`;
	}
}
