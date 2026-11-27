export * as SystemWorkAuthentication from "./system-work.ts";

import { type DomainError, userText } from "@sugabots/errors";
import { and, eq } from "drizzle-orm";
import { Context, DateTime, Effect, ErrorReporter, Layer, Schema } from "effect";
import { AutomationStore } from "../chats/automations/store.ts";
import { Turns } from "../chats/turns/turns.ts";
import { idleComputerIds } from "../computers/project-computers.ts";
import { query, serviceOperations } from "../database/database.ts";
import { computer, message, placedChat, project, toolCall, workspace } from "../database/schema.ts";
import { isUuid } from "../ids/ids.ts";
import { authenticated, type DeletionTarget, type SystemWork } from "../principal.ts";
import { GitHubUninstalls } from "../providers/connectors/github/uninstalls.ts";
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
	readonly pendingDeletions: Effect.Effect<readonly DeletionTarget[]>;
	readonly deletion: (target: DeletionTarget) => Effect.Effect<SystemWork, StoredWorkGone>;
	readonly nextDueRoutineId: (excluded?: readonly string[]) => Effect.Effect<string | undefined>;
	readonly expiredApprovalIds: Effect.Effect<readonly string[]>;
	readonly approvalExpiry: (id: string) => Effect.Effect<SystemWork, StoredWorkGone>;
	readonly idleComputerIds: Effect.Effect<readonly string[]>;
	readonly pendingPauseIds: Effect.Effect<readonly string[]>;
	readonly dueGitHubUninstallIds: Effect.Effect<readonly string[]>;
	readonly gitHubUninstall: (id: string) => Effect.Effect<SystemWork, StoredWorkGone>;
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
		pendingDeletions: operation(
			"pendingDeletions",
			Effect.gen(function* () {
				const workspaces = yield* query((db) =>
					db.select({ id: workspace.id }).from(workspace).where(eq(workspace.deleting, true)),
				);
				const projects = yield* query((db) =>
					db
						.select({ id: project.id })
						.from(project)
						.innerJoin(workspace, eq(workspace.id, project.workspaceId))
						.where(and(eq(project.deleting, true), eq(workspace.deleting, false))),
				);
				return [
					...workspaces.map(({ id }) => ({ kind: "workspace" as const, id })),
					...projects.map(({ id }) => ({ kind: "project" as const, id })),
				];
			}),
		),
		deletion: (target) =>
			operation(
				"deletion",
				Effect.gen(function* () {
					if (!isUuid(target.id)) return yield* new StoredWorkGone({ work: "deletion" });
					const [row] =
						target.kind === "workspace"
							? yield* query((db) =>
									db
										.select({ id: workspace.id, workspace: workspace.id })
										.from(workspace)
										.where(and(eq(workspace.id, target.id), eq(workspace.deleting, true))),
								)
							: yield* query((db) =>
									db
										.select({ id: project.id, workspace: project.workspaceId })
										.from(project)
										.where(and(eq(project.id, target.id), eq(project.deleting, true))),
								);
					if (!row) return yield* new StoredWorkGone({ work: "deletion" });
					return authenticated.systemWork({
						workspace: row.workspace,
						work: { kind: "deletion", targetKind: target.kind, id: row.id },
					});
				}),
			),

		nextDueRoutineId: (excluded = []) =>
			operation(
				"nextDueRoutineId",
				DateTime.nowAsDate.pipe(
					Effect.flatMap((now) => AutomationStore.nextDueRoutine(now, excluded)),
					Effect.map(([row]) => row?.id),
				),
			),
		expiredApprovalIds: operation(
			"expiredApprovalIds",
			Turns.dueApprovals().pipe(Effect.map((rows) => rows.flatMap(({ id }) => (id ? [id] : [])))),
		),
		approvalExpiry: (id) =>
			operation(
				"approvalExpiry",
				Effect.gen(function* () {
					const [due] = yield* Turns.dueApprovals(eq(toolCall.approvalId, id));
					if (!due) return yield* new StoredWorkGone({ work: "approvalExpiry" });
					return authenticated.systemWork({
						workspace: due.workspace,
						work: { kind: "approvalExpiry", approval: id },
					});
				}),
			),
		idleComputerIds: operation(
			"idleComputerIds",
			DateTime.now.pipe(
				Effect.flatMap(idleComputerIds),
				Effect.map((rows) => rows.map(({ id }) => id)),
			),
		),
		pendingPauseIds: operation(
			"pendingPauseIds",
			AutomationStore.pendingPauseIds.pipe(Effect.map((rows) => rows.map(({ id }) => id))),
		),
		dueGitHubUninstallIds: operation(
			"dueGitHubUninstallIds",
			DateTime.nowAsDate.pipe(
				Effect.flatMap(GitHubUninstalls.dueIds),
				Effect.map((rows) => rows.map(({ id }) => id)),
			),
		),
		gitHubUninstall: (id) =>
			operation(
				"gitHubUninstall",
				Effect.gen(function* () {
					const [row] = isUuid(id)
						? yield* GitHubUninstalls.dueUninstall(yield* DateTime.nowAsDate, id)
						: [];
					if (!row) return yield* new StoredWorkGone({ work: "gitHubUninstall" });
					return authenticated.systemWork({
						workspace: row.workspace,
						work: { kind: "gitHubUninstall", uninstall: id },
					});
				}),
			),

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
						? yield* AutomationStore.dueRoutine(yield* DateTime.nowAsDate, triggerId)
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
					const [row] = isUuid(automationId) ? yield* AutomationStore.pauseDue(automationId) : [];
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
		work: Schema.Literals([
			"compaction",
			"computerSleep",
			"approvalExpiry",
			"dueRoutine",
			"pauseAfterFailures",
			"gitHubUninstall",
			"deletion",
		]),
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
