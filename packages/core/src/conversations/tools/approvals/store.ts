import type { ToolApprovalDecision, ToolApprovalRule, ToolCallPart } from "@sugabots/contracts";
import { streamEvent, threadChannel, workspaceRoleOf } from "@sugabots/contracts";
import type { ToolApprovalResponse, ToolModelMessage } from "ai";
import { and, eq, inArray, sql } from "drizzle-orm";
import { Data, Effect } from "effect";
import { type Database, query, transaction } from "../../../database/database.ts";
import type { PublishEvents } from "../../../database/events/publish.ts";
import type * as schema from "../../../database/schema.ts";
import {
	agent,
	connection,
	job,
	pod,
	podMember,
	routineExecution,
	thread,
	toolApprovalRule,
	toolCall,
	turn,
	user,
	workspaceMember,
} from "../../../database/schema.ts";
import { podStanding, podStandingFor } from "../../../workspaces/access.ts";
import { findRoutineExecutionId, routineSettlementLockKey } from "../../routines/execution.ts";
import { toToolCallPart } from "../../threads/tool-calls.ts";
import { boundedJson } from "../calls/store.ts";

export interface PendingToolApproval {
	id: string;
	approvalId: string;
	sdkToolCallId: string;
	tool: string;
	input: unknown;
	reason?: string;
	connectionId: string;
	connectionRevision: number;
	remoteToolName: string;
	atOffset: number;
}

export interface ToolApprovalStore {
	/**
	 * The offered tools an agent may use without asking again, because a
	 * standing approval covers them.
	 *
	 * A rule is only usable while whoever granted it still belongs to the
	 * workspace and still holds `approval.alwaysAllow` in this pod, so a
	 * demotion or a departure withdraws their standing approvals with them.
	 */
	allowedToolKeys(
		agentId: string,
		scope: { workspaceId: string; podId: string },
		tools: ReadonlyArray<{
			key: string;
			connectionId: string;
			connectionRevision: number;
			remoteToolName: string;
		}>,
	): Effect.Effect<Set<string>, never, Database>;
	responsesForTurn(
		turnId: string,
		approvalIds: readonly string[],
	): Effect.Effect<ToolModelMessage, Error, Database>;
	beginExecution(input: {
		threadId: string;
		messageId: string;
		turnId: string;
		sdkToolCallId: string;
		tool: string;
		input: unknown;
		atOffset: number;
		connectionId: string;
		connectionRevision: number;
		remoteToolName: string;
		automaticallyAllowed: boolean;
	}): Effect.Effect<ToolCallPart, Error, Database>;
	decide(input: {
		workspaceId: string;
		podId: string;
		toolCallId: string;
		userId: string;
		decision: ToolApprovalDecision["decision"];
	}): Effect.Effect<
		ToolCallPart,
		ToolApprovalNotFound | ToolApprovalConflict | ToolApprovalForbidden,
		Database
	>;
	listRules(workspaceId: string, podId: string): Effect.Effect<ToolApprovalRule[], never, Database>;
	revokeRule(
		workspaceId: string,
		podId: string,
		ruleId: string,
	): Effect.Effect<boolean, never, Database>;
}

export class ToolApprovalNotFound extends Data.TaggedError("ToolApprovalNotFound") {}
export class ToolApprovalConflict extends Data.TaggedError("ToolApprovalConflict") {}
export class ToolApprovalForbidden extends Data.TaggedError("ToolApprovalForbidden") {}

export function toolApprovalStore(publishEvents: PublishEvents): ToolApprovalStore {
	return {
		allowedToolKeys: (agentId, scope, tools) => {
			if (tools.length === 0) return Effect.succeed(new Set());
			return query(async (db) => {
				const connectionIds = [...new Set(tools.map((tool) => tool.connectionId))];
				const rows = await db
					.select({
						connectionId: toolApprovalRule.connectionId,
						connectionRevision: toolApprovalRule.connectionRevision,
						toolName: toolApprovalRule.toolName,
						...grantorColumns,
					})
					.from(toolApprovalRule)
					.innerJoin(pod, eq(pod.id, toolApprovalRule.podId))
					.leftJoin(
						workspaceMember,
						and(
							eq(workspaceMember.workspaceId, toolApprovalRule.workspaceId),
							eq(workspaceMember.userId, toolApprovalRule.createdById),
						),
					)
					.leftJoin(
						podMember,
						and(
							eq(podMember.podId, toolApprovalRule.podId),
							eq(podMember.userId, toolApprovalRule.createdById),
						),
					)
					.where(
						and(
							eq(toolApprovalRule.agentId, agentId),
							eq(toolApprovalRule.workspaceId, scope.workspaceId),
							eq(toolApprovalRule.podId, scope.podId),
							inArray(toolApprovalRule.connectionId, connectionIds),
						),
					);
				const allowed = new Set(
					rows
						.filter(grantorStillMayAlwaysAllow)
						.map((row) => `${row.connectionId}:${row.connectionRevision}:${row.toolName}`),
				);
				return new Set(
					tools
						.filter((tool) =>
							allowed.has(`${tool.connectionId}:${tool.connectionRevision}:${tool.remoteToolName}`),
						)
						.map((tool) => tool.key),
				);
			});
		},

		responsesForTurn: (turnId, approvalIds) =>
			Effect.flatMap(
				query((db) =>
					db
						.select({ approvalId: toolCall.approvalId, status: toolCall.approvalStatus })
						.from(toolCall)
						.where(and(eq(toolCall.turnId, turnId), inArray(toolCall.approvalId, [...approvalIds])))
						.orderBy(toolCall.createdAt, toolCall.id),
				),
				(rows) => {
					const expected = new Set(approvalIds);
					if (
						rows.length !== expected.size ||
						rows.some(
							(row) => !row.approvalId || !expected.has(row.approvalId) || row.status === "pending",
						)
					) {
						return Effect.fail(new Error("Turn approval decisions are incomplete"));
					}
					return Effect.succeed({
						role: "tool" as const,
						content: rows.map(
							(row): ToolApprovalResponse => ({
								type: "tool-approval-response",
								approvalId: row.approvalId as string,
								approved: row.status === "allowed",
								reason:
									row.status === "allowed"
										? "A person approved this action"
										: "A person denied this action",
							}),
						),
					});
				},
			),

		beginExecution: (input) =>
			transaction(
				Effect.gen(function* () {
					const executionId = yield* query((db) => findRoutineExecutionId(db, input.threadId));
					if (executionId) {
						const lockKey = routineSettlementLockKey(executionId);
						yield* query((db) =>
							db.execute(sql`select pg_advisory_xact_lock(hashtextextended(${lockKey}, 0))`),
						);
						const [execution] = yield* query((db) =>
							db
								.select({
									state: routineExecution.state,
									pendingTerminalState: routineExecution.pendingTerminalState,
								})
								.from(routineExecution)
								.where(eq(routineExecution.id, executionId))
								.limit(1),
						);
						if (execution?.state !== "running" || execution.pendingTerminalState) {
							return yield* Effect.fail(new Error("Routine execution has ended"));
						}
					}
					const [scope] = yield* query((db) =>
						db
							.select({
								agentId: turn.agentId,
								workspaceId: thread.workspaceId,
								podId: thread.podId,
							})
							.from(turn)
							.innerJoin(thread, eq(thread.id, turn.threadId))
							.innerJoin(pod, eq(pod.id, thread.podId))
							.where(
								and(
									eq(turn.id, input.turnId),
									eq(turn.threadId, input.threadId),
									eq(turn.status, "running"),
									eq(turn.cancelRequested, false),
								),
							)
							.limit(1)
							.for("update"),
					);
					if (!scope) return yield* Effect.fail(new Error("Turn is not running"));
					const [currentConnection] = yield* query((db) =>
						db
							.select({ revision: connection.configurationRevision })
							.from(connection)
							.where(
								and(
									eq(connection.id, input.connectionId),
									eq(connection.workspaceId, scope.workspaceId),
									eq(connection.podId, scope.podId),
									eq(connection.enabled, true),
									eq(connection.allowMutating, true),
									eq(connection.configurationRevision, input.connectionRevision),
								),
							)
							.limit(1)
							.for("update"),
					);
					if (!currentConnection) {
						return yield* Effect.fail(new Error("Connection configuration changed after approval"));
					}
					const [existing] = yield* query((db) =>
						db
							.select()
							.from(toolCall)
							.where(
								and(
									eq(toolCall.turnId, input.turnId),
									eq(toolCall.sdkToolCallId, input.sdkToolCallId),
								),
							)
							.limit(1)
							.for("update"),
					);
					if (existing) {
						if (existing.approvalStatus !== "allowed" || existing.status !== "awaiting_approval") {
							return yield* Effect.fail(new Error("Tool call is not approved for execution"));
						}
						const [running] = yield* query((db) =>
							db
								.update(toolCall)
								.set({ status: "running", startedAt: new Date() })
								.where(
									and(
										eq(toolCall.id, existing.id),
										eq(toolCall.threadId, input.threadId),
										eq(toolCall.messageId, input.messageId),
										eq(toolCall.status, "awaiting_approval"),
										eq(toolCall.tool, input.tool),
										eq(toolCall.connectionId, input.connectionId),
										eq(toolCall.connectionRevision, input.connectionRevision),
										eq(toolCall.remoteToolName, input.remoteToolName),
										sql`${toolCall.executionInput} = ${JSON.stringify(executionJson(input.input))}::jsonb`,
									),
								)
								.returning(),
						);
						if (!running)
							return yield* Effect.fail(new Error("Tool call execution was already claimed"));
						yield* markMutationStarted(running.turnId);
						const part = toToolCallPart(running);
						yield* publishEvents([
							callEvent("tool_call.updated", part, running.threadId, running.messageId),
						]);
						return part;
					}

					if (!input.automaticallyAllowed) {
						return yield* Effect.fail(new Error("Tool call has no approval record"));
					}
					// Locked and re-read inside the settling transaction, and its
					// grantor's authority asked for again: a rule revoked, or a
					// grantor demoted or removed, between the turn being prepared
					// and the call being dispatched must stop the call.
					const [currentRule] = yield* query((db) =>
						db
							.select({ id: toolApprovalRule.id, grantorId: toolApprovalRule.createdById })
							.from(toolApprovalRule)
							.where(
								and(
									eq(toolApprovalRule.workspaceId, scope.workspaceId),
									eq(toolApprovalRule.podId, scope.podId),
									eq(toolApprovalRule.agentId, scope.agentId),
									eq(toolApprovalRule.connectionId, input.connectionId),
									eq(toolApprovalRule.connectionRevision, input.connectionRevision),
									eq(toolApprovalRule.toolName, input.remoteToolName),
								),
							)
							.limit(1)
							.for("update"),
					);
					if (!currentRule) {
						return yield* Effect.fail(new Error("Tool call has no current approval rule"));
					}
					const grantor = yield* query((db) =>
						podStandingFor(db, scope.podId, currentRule.grantorId),
					);
					if (!grantor?.may("approval.alwaysAllow")) {
						return yield* Effect.fail(
							new Error("The standing approval's grantor is no longer allowed to give one"),
						);
					}
					const [created] = yield* query((db) =>
						db
							.insert(toolCall)
							.values({
								threadId: input.threadId,
								messageId: input.messageId,
								turnId: input.turnId,
								tool: input.tool,
								sdkToolCallId: input.sdkToolCallId,
								approvalStatus: "automatic",
								connectionId: input.connectionId,
								connectionRevision: input.connectionRevision,
								remoteToolName: input.remoteToolName,
								input: boundedJson(input.input),
								executionInput: executionJson(input.input),
								status: "running",
								mutating: true,
								atOffset: input.atOffset,
							})
							.returning(),
					);
					if (!created) return yield* Effect.fail(new Error("Tool call insert returned no row"));
					yield* markMutationStarted(created.turnId);
					const part = toToolCallPart(created);
					yield* publishEvents([
						callEvent("tool_call.started", part, created.threadId, created.messageId),
					]);
					return part;
				}),
			),

		decide: (input) =>
			transaction(
				Effect.gen(function* () {
					const [approvalThread] = yield* query((db) =>
						db
							.select({ id: thread.id })
							.from(toolCall)
							.innerJoin(thread, eq(thread.id, toolCall.threadId))
							.where(
								and(
									eq(toolCall.id, input.toolCallId),
									eq(thread.workspaceId, input.workspaceId),
									eq(thread.podId, input.podId),
								),
							)
							.limit(1),
					);
					if (!approvalThread) return yield* new ToolApprovalNotFound();
					const routineExecutionId = yield* query((db) =>
						findRoutineExecutionId(db, approvalThread.id),
					);
					if (routineExecutionId) {
						const lockKey = routineSettlementLockKey(routineExecutionId);
						yield* query((db) =>
							db.execute(sql`select pg_advisory_xact_lock(hashtextextended(${lockKey}, 0))`),
						);
					}
					const [candidate] = yield* query((db) =>
						db
							.select({
								call: toolCall,
								threadId: thread.id,
								agentId: turn.agentId,
								jobId: turn.jobId,
							})
							.from(toolCall)
							.innerJoin(turn, eq(turn.id, toolCall.turnId))
							.innerJoin(thread, eq(thread.id, toolCall.threadId))
							.where(
								and(
									eq(toolCall.id, input.toolCallId),
									eq(thread.workspaceId, input.workspaceId),
									eq(thread.podId, input.podId),
									eq(turn.status, "waiting"),
									eq(turn.cancelRequested, false),
								),
							)
							.limit(1)
							.for("update"),
					);
					if (!candidate?.call.approvalId) return yield* new ToolApprovalNotFound();
					// The caller's authority is read again here, inside the
					// transaction that settles the call, so a demotion between the
					// route's check and the write does not slip through. Somebody who
					// cannot decide at all is told nothing is there, exactly as the
					// route would have.
					const decider = yield* query((db) => podStandingFor(db, input.podId, input.userId));
					if (!decider?.may("approval.decide")) {
						return yield* new ToolApprovalNotFound();
					}
					if (candidate.call.approvalStatus !== "pending") return yield* new ToolApprovalConflict();
					if (routineExecutionId && !decider.may("approval.routine.decide")) {
						return yield* new ToolApprovalForbidden();
					}
					if (input.decision === "always_allow" && !decider.may("approval.alwaysAllow")) {
						return yield* new ToolApprovalForbidden();
					}
					const allowed = input.decision !== "deny";
					if (input.decision === "always_allow") {
						if (
							!candidate.call.connectionId ||
							!candidate.call.connectionRevision ||
							!candidate.call.remoteToolName
						) {
							return yield* new ToolApprovalConflict();
						}
						const connectionId = candidate.call.connectionId;
						const connectionRevision = candidate.call.connectionRevision;
						const toolName = candidate.call.remoteToolName;
						const [currentConnection] = yield* query((db) =>
							db
								.select({ id: connection.id })
								.from(connection)
								.where(
									and(
										eq(connection.id, connectionId),
										eq(connection.workspaceId, input.workspaceId),
										eq(connection.podId, input.podId),
										eq(connection.configurationRevision, connectionRevision),
									),
								)
								.limit(1)
								.for("update"),
						);
						if (!currentConnection) return yield* new ToolApprovalConflict();
						const newRule: typeof toolApprovalRule.$inferInsert = {
							workspaceId: input.workspaceId,
							podId: input.podId,
							agentId: candidate.agentId,
							connectionId,
							connectionRevision,
							toolName,
							createdById: input.userId,
						};
						yield* query((db) =>
							db
								.insert(toolApprovalRule)
								.values(newRule)
								.onConflictDoUpdate({
									target: [
										toolApprovalRule.agentId,
										toolApprovalRule.connectionId,
										toolApprovalRule.toolName,
										toolApprovalRule.createdById,
									],
									set: { connectionRevision },
								}),
						);
					}
					const [updated] = yield* query((db) =>
						db
							.update(toolCall)
							.set({
								approvalStatus: allowed ? "allowed" : "denied",
								decidedById: input.userId,
								decidedAt: new Date(),
								...(allowed
									? {}
									: {
											status: "completed" as const,
											output: boundedJson({
												status: "denied",
												reason: "A person denied this action",
											}),
											finishedAt: new Date(),
										}),
							})
							.where(and(eq(toolCall.id, input.toolCallId), eq(toolCall.approvalStatus, "pending")))
							.returning(),
					);
					if (!updated) return yield* new ToolApprovalConflict();
					const [deciderName] = yield* query((db) =>
						db.select({ name: user.name }).from(user).where(eq(user.id, input.userId)).limit(1),
					);
					const part = toToolCallPart(updated, deciderName?.name ?? null);
					yield* publishEvents([
						callEvent("tool_call.updated", part, updated.threadId, updated.messageId),
					]);

					const [count] = yield* query((db) =>
						db
							.select({ unresolved: sql<number>`count(*)`.mapWith(Number) })
							.from(toolCall)
							.where(
								and(eq(toolCall.turnId, updated.turnId), eq(toolCall.approvalStatus, "pending")),
							),
					);
					if ((count?.unresolved ?? 0) === 0) {
						yield* query((db) =>
							db
								.update(job)
								.set({ status: "queued", availableAt: new Date(), lockedAt: null })
								.where(
									and(
										eq(job.id, candidate.jobId ?? "00000000-0000-0000-0000-000000000000"),
										eq(job.status, "waiting"),
										sql`exists (
											select 1 from ${turn}
											where ${turn.jobId} = ${job.id}
												and ${turn.status} = 'waiting'
												and ${turn.cancelRequested} = false
										)`,
									),
								),
						);
					}
					return part;
				}),
			),

		listRules: (workspaceId, podId) =>
			query(async (db) => {
				const rows = await db
					.select({
						rule: toolApprovalRule,
						agentName: agent.name,
						connectionName: connection.name,
					})
					.from(toolApprovalRule)
					.innerJoin(agent, eq(agent.id, toolApprovalRule.agentId))
					.innerJoin(connection, eq(connection.id, toolApprovalRule.connectionId))
					.where(
						and(eq(toolApprovalRule.workspaceId, workspaceId), eq(toolApprovalRule.podId, podId)),
					);
				return rows.map(({ rule, agentName, connectionName }) => ({
					id: rule.id,
					agentId: rule.agentId,
					agentName,
					connectionId: rule.connectionId,
					connectionName,
					toolName: rule.toolName,
					createdAt: rule.createdAt.toISOString(),
				}));
			}),

		revokeRule: (workspaceId, podId, ruleId) =>
			Effect.map(
				query((db) =>
					db
						.delete(toolApprovalRule)
						.where(
							and(
								eq(toolApprovalRule.id, ruleId),
								eq(toolApprovalRule.workspaceId, workspaceId),
								eq(toolApprovalRule.podId, podId),
							),
						)
						.returning({ id: toolApprovalRule.id }),
				),
				(rows) => rows.length === 1,
			),
	};
}

/** No connection approvals for workers that are not offered connection tools. */
export const noToolApprovalStore: ToolApprovalStore = {
	allowedToolKeys: () => Effect.succeed(new Set()),
	responsesForTurn: () => Effect.fail(new Error("Tool approvals are not configured")),
	beginExecution: () => Effect.fail(new Error("Tool approvals are not configured")),
	decide: () => Effect.fail(new ToolApprovalNotFound()),
	listRules: () => Effect.succeed([]),
	revokeRule: () => Effect.succeed(false),
};

/**
 * The grantor's standing, joined beside a stored approval rule.
 *
 * Joined rather than loaded one rule at a time: this runs while a turn is
 * being prepared, over every rule the agent's connections could match.
 */
const grantorColumns = {
	pod,
	grantorId: toolApprovalRule.createdById,
	role: workspaceMember.role,
	membershipId: podMember.id,
};

function grantorStillMayAlwaysAllow(row: {
	pod: schema.PodRow;
	grantorId: string;
	role: string | null;
	membershipId: string | null;
}): boolean {
	return podStanding(
		row.pod,
		{ userId: row.grantorId, workspaceRole: workspaceRoleOf(row.role) },
		row.membershipId !== null,
	).may("approval.alwaysAllow");
}

export function executionJson(value: unknown) {
	return JSON.parse(JSON.stringify(value ?? null));
}

const markMutationStarted = (turnId: string) =>
	query((db) =>
		db
			.update(turn)
			.set({
				mutationStarted: true,
				checkpoint: sql`case when ${turn.checkpoint} is null then null else jsonb_set(${turn.checkpoint}, '{reply,acted}', 'true'::jsonb, true) end`,
			})
			.where(eq(turn.id, turnId)),
	).pipe(Effect.asVoid);

function callEvent(
	type: "tool_call.started" | "tool_call.updated",
	toolCallPart: ToolCallPart,
	threadId: string,
	messageId: string,
) {
	return {
		channel: threadChannel(threadId),
		event: streamEvent(type, { threadId, messageId, toolCall: toolCallPart }),
	};
}
