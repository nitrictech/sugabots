import type { ToolCallPart } from "@sugabots/contracts";
import {
	approvalSettingsChangeSchema,
	ToolApprovalConflict,
} from "@sugabots/contracts/errors/approvals";
import { eq, inArray } from "drizzle-orm";
import { Effect } from "effect";
import type { Executor } from "../../database/database.ts";
import { member, type ToolCallRow, toolCall } from "../../database/schema.ts";
import { STEERED_AWAY, TURN_CANCELLED, TURN_INTERRUPTED } from "../tool-call-end-messages.ts";
import { approversOf } from "../tools/approvers.ts";

/**
 * Reading tool calls back into the messages they belong to.
 *
 * A message stores a tool call by id only (`StoredMessagePart`); what the tool
 * was given and what it returned live on the `tool_call` row. These two
 * functions put the row back into the part the API hands out. Writing tool
 * calls is `turns/tool-calls/store.ts`.
 */

/** The tool calls made in each of these messages, keyed by message id. */
export const loadToolCallParts = Effect.fn("ToolCalls.loadToolCallParts")(function* (
	db: Executor,
	messageIds: readonly string[],
) {
	const byMessage = new Map<string, ToolCallPart[]>();
	if (messageIds.length === 0) {
		return byMessage;
	}
	const rows = yield* db
		.select({ call: toolCall, decidedByName: member.name })
		.from(toolCall)
		.leftJoin(member, eq(member.id, toolCall.decidedById))
		.where(inArray(toolCall.messageId, [...messageIds]))
		.orderBy(toolCall.startedAt, toolCall.id);
	for (const { call, decidedByName } of rows) {
		const parts = byMessage.get(call.messageId) ?? [];
		parts.push(toToolCallPart(call, decidedByName));
		byMessage.set(call.messageId, parts);
	}
	return byMessage;
});

export function toToolCallPart(
	row: ToolCallRow,
	decidedByName: string | null = null,
): ToolCallPart {
	const {
		automationRoutineId,
		browserUrl,
		briefBotName,
		briefProjectName,
		gitHubRepositoryId,
		gitHubBaseBranch,
		gitHubReviewCommit,
		gitHubReplyCommentId,
	} = row.approvalResolvedTargets ?? {};
	const closedBecause = readApprovalClosure(row);
	const approvalConnector =
		row.connectorId && row.connectorRevision !== null
			? { id: row.connectorId, revision: row.connectorRevision }
			: undefined;
	return {
		type: "tool_call",
		id: row.id,
		tool: row.tool,
		input: row.input,
		output: row.output ?? null,
		status: row.status,
		approval:
			row.approvalStatus && row.approvalId
				? {
						id: row.approvalId,
						status: row.approvalStatus,
						approvers: approversOf(row.tool),
						decidedByName,
						decidedAt: row.decidedAt?.toISOString() ?? null,
						...(closedBecause && { closedBecause }),
						...(browserUrl && { browserUrl }),
						...(briefBotName && {
							briefDestination: { botName: briefBotName, projectName: briefProjectName ?? null },
						}),
						...(automationRoutineId !== undefined && {
							routineChange: automationRoutineId === null ? "add" : "replace",
						}),
						...(gitHubRepositoryId && {
							gitHub: {
								repositoryId: gitHubRepositoryId,
								...(gitHubBaseBranch && { baseBranch: gitHubBaseBranch }),
								...(gitHubReviewCommit && { reviewCommit: gitHubReviewCommit }),
								...(gitHubReplyCommentId && { replyCommentId: gitHubReplyCommentId }),
							},
						}),
						...(approvalConnector && { connector: approvalConnector }),
					}
				: null,
		error: row.error,
		atOffset: row.atOffset,
		startedAt: row.startedAt.toISOString(),
		finishedAt: row.finishedAt?.toISOString() ?? null,
	};
}

const settingsChangeMessages = new Set<string>(
	approvalSettingsChangeSchema.literals.map(
		(reason) => new ToolApprovalConflict({ reason }).userMessage,
	),
);

function readApprovalClosure(row: ToolCallRow) {
	const { approvalStatus, decidedAt, finishedAt, error } = row;
	if (approvalStatus !== "denied" || decidedAt || !finishedAt || error === null) return undefined;
	if (settingsChangeMessages.has(error)) return "settingsChanged";
	if (error === STEERED_AWAY) return "newMessage";
	if (error === TURN_CANCELLED || error === TURN_INTERRUPTED) return "botStopped";
	return "withdrawn";
}
