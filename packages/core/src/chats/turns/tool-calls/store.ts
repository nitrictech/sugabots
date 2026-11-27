export * as ToolCallStore from "./store.ts";

import { isDeepStrictEqual } from "node:util";
import type { FileWritten, JsonValue, ToolApprovalStatus, ToolCallPart } from "@sugabots/contracts";
import { ApprovalRefused } from "@sugabots/contracts/errors/proofs";
import type { UserText } from "@sugabots/errors";
import { and, desc, eq, exists, inArray, isNotNull, type SQL, sql } from "drizzle-orm";
import { Context, DateTime, Effect, Layer } from "effect";
import {
	type Database,
	query,
	serviceOperations,
	type Transaction,
	transaction,
	writtenRow,
} from "../../../database/database.ts";
import {
	chat,
	connector,
	member,
	message,
	projectBot,
	type ToolCallRow,
	toolCall,
	turn,
} from "../../../database/schema.ts";
import type { ResolvedTargets } from "../../../operations/operation.ts";
import type { RunsTurn } from "../../../proofs/runs-turn.ts";
import { processLayer, Tier } from "../../../tiers.ts";
import { ChatEvents } from "../../chat-events.ts";
import { ChatEvent, type ToolCallChange } from "../../events.ts";
import { toToolCallPart } from "../../store/tool-calls.ts";
import { withImagesCounted } from "../../tools/images.ts";
import { asRecordedJson, sameRecordedInput } from "../../tools/recorded-input.ts";
import {
	type FencedProof,
	type FenceRefusal,
	holdRunningTurn,
	holdTurnForToolWrite,
} from "../fence.ts";
import type { ApprovalBinding } from "../loop-values.ts";
import { mayRunTools } from "../lifecycle.ts";
import { WorkAdmission } from "../work-admission.ts";
import {
	APPROVAL_NO_LONGER_APPLIES,
	type ApprovalDecision,
	INTERRUPTED_CALL,
	isFinished,
	ToolCallEvent,
	type ToolCallState,
	transition,
	UNFINISHED_STATUSES,
} from "./lifecycle.ts";

/**
 * The only writer of `tool_call`: what a bot's reply asked a tool, whether
 * a member allowed it, and what it got.
 *
 * Each command locks the call, asks `lifecycle.ts` what the command makes of
 * it, writes that and emits it, in one transaction. A command the lifecycle
 * refuses writes nothing.
 *
 * A call is opened when the tool starts and closed when it returns, each in
 * its own transaction, so a reader watching the chat sees the call appear
 * and then resolve. The reply keeps a reference to the call among its parts at
 * the point it was made; the input and output live here, so the tool never
 * writes the row the reply being written is saved to.
 */
export interface Interface {
	/**
	 * Records that the turn `runsTurn` is about is sending a call to a tool
	 * needing no approval, before it is sent. `toolCallId` is the model's id
	 * for the call in its step `step`; with the turn, they are the call's key,
	 * so it is recorded once. `undefined` when an execution recorded it first.
	 */
	readonly open: <P, T>(
		runsTurn: RunsTurn<P, T>,
		input: {
			/** The row's id, when the caller places the call before recording it. */
			id?: string;
			chatId: string;
			messageId: string;
			step: number;
			toolCallId: string;
			tool: string;
			input: unknown;
			/** How far into the reply's text the call was made. */
			atOffset: number;
			/** Whether the tool may change something at the other end. */
			writeOrDelete: boolean;
			/** The tool the call is bound to: a connector's, as configured now, or a built-in one. */
			binding: ApprovalBinding;
		},
	) => Effect.Effect<ToolCallPart | undefined, FenceRefusal>;
	/**
	 * Claims the recorded call `callId`, still running, for this execution of
	 * its turn to send again: `false` when this execution sent it already.
	 */
	readonly claim: <P, T>(
		runsTurn: RunsTurn<P, T>,
		callId: string,
	) => Effect.Effect<boolean, FenceRefusal>;
	/**
	 * The call the turn `runsTurn` is about recorded under the key of its step
	 * `step` and the model's id `toolCallId`, if one did; with no step, its
	 * newest call with that id that waited for approval. Locks the turn's row,
	 * so nothing else records it meanwhile.
	 */
	readonly sent: <P, T>(
		runsTurn: RunsTurn<P, T>,
		key: { readonly step?: number; readonly toolCallId: string },
	) => Effect.Effect<ToolCallRow | undefined, FenceRefusal>;
	/** The model's ids for calls already recorded for this step of the turn. */
	readonly recordedCallIds: (turnId: string, step: number) => Effect.Effect<readonly string[]>;
	/**
	 * Ends the call `callId`, sent but not finished, as interrupted, telling
	 * members `userMessage` of it; a pending approval is denied. `undefined`
	 * if it had finished.
	 */
	readonly interrupt: <P, T>(
		runsTurn: RunsTurn<P, T>,
		callId: string,
		userMessage: UserText,
	) => Effect.Effect<ToolCallPart | undefined, FenceRefusal>;
	/** Records what the tool returned or how it failed. `undefined` if the call is not running. */
	readonly close: <P, T>(
		runsTurn: RunsTurn<P, T>,
		toolCallId: string,
		outcome: ToolCallOutcome,
	) => Effect.Effect<ToolCallPart | undefined, FenceRefusal>;
	/** Parks the calls a reply asked for until members decide them. */
	readonly requestApprovals: (
		reply: { chatId: string; messageId: string; turnId: string },
		approvals: readonly PendingToolApproval[],
	) => Effect.Effect<void>;
	/**
	 * Records a decision on an approval in the chat. `false`, changing
	 * nothing, once it is decided: the first decision recorded stands.
	 */
	readonly recordDecision: (input: {
		chatId: string;
		approvalId: string;
		decision: ApprovalDecision;
	}) => Effect.Effect<boolean>;
	/**
	 * Starts an allowed call, if it is exactly the call that was approved, its
	 * turn may still run tools, its connector is configured as it was when
	 * approved, and its automation run, if any, still takes work (see
	 * `WorkAdmission`).
	 */
	readonly beginExecution: <P, T>(
		runsTurn: RunsTurn<P, T>,
		input: {
			sdkToolCallId: string;
			tool: string;
			input: unknown;
			binding: ApprovalBinding;
		},
	) => Effect.Effect<BeganExecution, FenceRefusal>;
	/** How each of the turn `turnId`'s approvals `approvalIds` stands, by approval. */
	readonly decisions: (
		turnId: string,
		approvalIds: readonly string[],
	) => Effect.Effect<ReadonlyMap<string, ToolApprovalStatus>>;
	/**
	 * Fails these turns' unfinished calls, denying pending approvals, for turns
	 * that ended before their tools returned. `userMessage` is what members are
	 * told of each call.
	 */
	readonly abandonUnfinished: (
		turnIds: readonly string[],
		userMessage: UserText,
	) => Effect.Effect<void>;
	/**
	 * Withdraws the approvals the turn `turnId` waits for that nobody has
	 * decided, as its asker's steer does: each such call ends unmade, telling
	 * members `userMessage`, and announces it. A call already allowed is left
	 * for the turn to make. Says which approvals it withdrew.
	 */
	readonly withdrawPending: (
		turnId: string,
		userMessage: UserText,
	) => Effect.Effect<readonly string[]>;
	/** Forgets a reply's calls, for a retry that starts the reply again. */
	readonly forgetReply: (messageId: string) => Effect.Effect<void>;
}

export class Service extends Context.Service<Service, Interface>()("@sugabots/core/ToolCallStore") {
	declare readonly [Tier]: "process";
}

export const make = Effect.gen(function* () {
	const operation = yield* serviceOperations<Interface>("ToolCallStore");
	const { emit } = yield* ChatEvents.Service;
	const admission = yield* WorkAdmission.Service;

	/** Applies `event` to a locked call and writes the result. `undefined` when the lifecycle refuses. */
	const apply = Effect.fn("ToolCallStore.apply")(function* (
		row: ToolCallRow,
		event: ToolCallEvent,
	) {
		const decided = transition(stateOf(row), event);
		if (decided._tag === "Refused") return undefined;
		const next = decided.state;
		const now = yield* DateTime.nowAsDate;
		return yield* query((db) =>
			db
				.update(toolCall)
				.set({
					status: next.status,
					approvalStatus: next.approvalStatus,
					decidedById: next.decidedById,
					output: next.output,
					error: next.error,
					...(event._tag === "Decide" ? { decidedAt: now } : {}),
					...(event._tag === "BeginExecution" ? { startedAt: now } : {}),
					...(isFinished(next.status) && !isFinished(row.status) ? { finishedAt: now } : {}),
				})
				.where(eq(toolCall.id, row.id))
				.returning(),
		).pipe(Effect.flatMap(writtenRow("tool_call")));
	});

	return Service.of({
		open: (runsTurn, input) =>
			operation(
				"open",
				transaction(
					Effect.gen(function* () {
						yield* holdRunningTurn(runsTurn, "share");
						const startedAt = yield* DateTime.nowAsDate;
						const [row] = yield* query((db) =>
							db
								.insert(toolCall)
								.values({
									...(input.id === undefined ? {} : { id: input.id }),
									chatId: input.chatId,
									messageId: input.messageId,
									turnId: runsTurn.turn.value,
									step: input.step,
									sdkToolCallId: input.toolCallId,
									tool: input.tool,
									input: boundedJson(input.input),
									atOffset: input.atOffset,
									writeOrDelete: input.writeOrDelete,
									...bindingColumns(input.binding),
									executionInput: asRecordedJson(input.input),
									sentInExecution: runsTurn.execution,
									startedAt,
								})
								.onConflictDoNothing({
									target: [toolCall.turnId, toolCall.step, toolCall.sdkToolCallId],
								})
								.returning(),
						);
						if (!row) return undefined;
						yield* emit([ChatEvent.ToolCallStarted(toolCallChange(row))]);
						return toToolCallPart(row);
					}),
				),
			),

		sent: (runsTurn, key) =>
			operation(
				"sent",
				transaction(
					Effect.gen(function* () {
						yield* holdRunningTurn(runsTurn, "update");
						const [row] = yield* query((db) =>
							db
								.select()
								.from(toolCall)
								.where(
									and(
										eq(toolCall.turnId, runsTurn.turn.value),
										eq(toolCall.sdkToolCallId, key.toolCallId),
										key.step === undefined
											? isNotNull(toolCall.approvalId)
											: eq(toolCall.step, key.step),
									),
								)
								.orderBy(desc(toolCall.createdAt), desc(toolCall.id))
								.limit(1),
						);
						return row;
					}),
				),
			),

		recordedCallIds: (turnId, step) =>
			operation(
				"recordedCallIds",
				Effect.map(
					query((db) =>
						db
							.select({ id: toolCall.sdkToolCallId })
							.from(toolCall)
							.where(and(eq(toolCall.turnId, turnId), eq(toolCall.step, step))),
					),
					(rows) => rows.flatMap(({ id }) => (id === null ? [] : [id])),
				),
			),

		claim: (runsTurn, callId) =>
			operation(
				"claim",
				transaction(
					Effect.gen(function* () {
						yield* holdRunningTurn(runsTurn, "share");
						const claimed = yield* query((db) =>
							db
								.update(toolCall)
								.set({ sentInExecution: runsTurn.execution })
								.where(
									and(
										eq(toolCall.id, callId),
										eq(toolCall.turnId, runsTurn.turn.value),
										eq(toolCall.status, "running"),
										sql`${toolCall.sentInExecution} is distinct from ${runsTurn.execution}`,
									),
								)
								.returning({ id: toolCall.id }),
						);
						return claimed.length > 0;
					}),
				),
			),

		interrupt: (runsTurn, callId, userMessage) =>
			operation(
				"interrupt",
				transaction(
					Effect.gen(function* () {
						yield* holdRunningTurn(runsTurn, "share");
						const row = yield* lockedCall(
							and(eq(toolCall.id, callId), eq(toolCall.turnId, runsTurn.turn.value)),
						);
						if (!row) return undefined;
						const interrupted = yield* apply(row, ToolCallEvent.Abandon({ userMessage }));
						if (!interrupted) return undefined;
						yield* emit([ChatEvent.ToolCallFinished(toolCallChange(interrupted))]);
						return toToolCallPart(interrupted);
					}),
				),
			),

		close: (runsTurn, toolCallId, outcome) =>
			operation(
				"close",
				transaction(
					Effect.gen(function* () {
						yield* holdRunningTurn(runsTurn, "share");
						const row = yield* lockedCall(
							and(eq(toolCall.id, toolCallId), eq(toolCall.turnId, runsTurn.turn.value)),
						);
						if (!row) return undefined;
						const closed = yield* apply(
							row,
							ToolCallEvent.Close({
								outcome:
									"error" in outcome
										? outcome
										: { output: boundedJson(withImagesCounted(outcome.output)) },
							}),
						);
						if (!closed) return undefined;
						yield* emit([ChatEvent.ToolCallFinished(toolCallChange(closed))]);
						return toToolCallPart(closed);
					}),
				),
			),

		requestApprovals: (reply, approvals) =>
			operation(
				"requestApprovals",
				transaction(
					Effect.gen(function* () {
						if (approvals.length === 0) return;
						const askedAt = yield* DateTime.nowAsDate;
						const fresh = approvals.filter((call) => !call.reopen);
						const rows =
							fresh.length === 0
								? []
								: yield* query((db) =>
										db
											.insert(toolCall)
											.values(
												fresh.map((approval) => ({
													id: approval.id,
													chatId: reply.chatId,
													messageId: reply.messageId,
													turnId: reply.turnId,
													step: approval.step,
													tool: approval.tool,
													sdkToolCallId: approval.sdkToolCallId,
													approvalId: approval.approvalId,
													approvalStatus: "pending" as const,
													approvalReason: approval.reason ?? null,
													approvalComputerProjectId: approval.computerProjectId ?? null,
													approvalResolvedTargets: approval.resolvedTargets ?? null,
													approvalConnectorAccess: approval.connectorAccess ?? null,
													approvalAskedAt: askedAt,
													...bindingColumns(approval.binding),
													input: boundedJson(approval.input),
													executionInput: asRecordedJson(approval.input),
													status: "awaiting_approval" as const,
													writeOrDelete: approval.writeOrDelete,
													atOffset: approval.atOffset,
												})),
											)
											.returning(),
									);
						for (const approval of approvals.filter((call) => call.reopen)) {
							const row = yield* lockedCall(
								and(
									eq(toolCall.id, approval.id),
									eq(toolCall.turnId, reply.turnId),
									eq(toolCall.step, approval.step),
									eq(toolCall.sdkToolCallId, approval.sdkToolCallId),
									eq(toolCall.status, "running"),
								),
							);
							if (!row || !sameCallAsApproved(row, approval))
								return yield* Effect.die(new Error("Tool call cannot be reopened for approval"));
							const updated = yield* query((db) =>
								db
									.update(toolCall)
									.set({
										approvalId: approval.approvalId,
										approvalStatus: "pending",
										approvalReason: approval.reason ?? null,
										approvalComputerProjectId: approval.computerProjectId ?? null,
										approvalResolvedTargets: approval.resolvedTargets ?? null,
										approvalConnectorAccess: approval.connectorAccess ?? null,
										approvalAskedAt: askedAt,
										decidedById: null,
										decidedAt: null,
										sentInExecution: null,
										status: "awaiting_approval",
										writeOrDelete: row.writeOrDelete || approval.writeOrDelete,
									})
									.where(eq(toolCall.id, row.id))
									.returning(),
							);
							rows.push(...updated);
						}
						// In the order the reply asked for them, which is how the chat lists them.
						const byId = new Map(rows.map((row) => [row.id, row]));
						yield* emit(
							approvals.flatMap((approval) => {
								const row = byId.get(approval.id);
								return row ? [ChatEvent.ToolCallStarted(toolCallChange(row))] : [];
							}),
						);
					}),
				),
			),

		recordDecision: (input) =>
			operation(
				"recordDecision",
				transaction(
					Effect.gen(function* () {
						const row = yield* lockedCall(
							and(eq(toolCall.chatId, input.chatId), eq(toolCall.approvalId, input.approvalId)),
						);
						if (!row) return false;
						const decided = yield* apply(row, ToolCallEvent.Decide({ decision: input.decision }));
						if (!decided) return false;
						// The approver is left-joined, as they may have left since deciding.
						const [placed] = yield* query((db) =>
							db
								.select({
									workspaceId: chat.workspaceId,
									approverName: member.name,
								})
								.from(chat)
								.leftJoin(member, eq(member.id, input.decision.memberId))
								.where(eq(chat.id, decided.chatId))
								.limit(1),
						);
						if (!placed) return yield* Effect.die(new Error("A decided call's chat is missing"));
						yield* emit([
							ChatEvent.ToolCallDecided({
								...toolCallChange(decided, placed.approverName),
								workspaceId: placed.workspaceId,
							}),
						]);
						return true;
					}),
				),
			),

		beginExecution: (runsTurn, input) =>
			operation(
				"beginExecution",
				transaction(
					Effect.gen(function* (): Effect.fn.Return<
						BeganExecution,
						FenceRefusal,
						Database | Transaction
					> {
						// Settlement locks the automation run before it locks any turn.
						const refused = yield* admission.refusal(runsTurn.chat);
						if (refused === "chatUnavailable") return refusedExecution("The chat is unavailable");
						if (refused === "automationEnded") {
							return refusedExecution("The automation run takes no more work");
						}
						yield* holdRunningTurn(runsTurn, "update");
						const [scope] = yield* query((db) =>
							db
								.select({
									messageId: message.id,
									workspaceId: chat.workspaceId,
									botId: turn.botId,
									status: turn.status,
									endRequested: turn.endRequested,
								})
								.from(turn)
								.innerJoin(chat, eq(chat.id, turn.chatId))
								.innerJoin(message, and(eq(message.turnId, turn.id), eq(message.chatId, chat.id)))
								.where(and(eq(turn.id, runsTurn.turn.value), eq(turn.chatId, runsTurn.chat)))
								.limit(1),
						);
						if (!scope || !mayRunTools(scope)) return refusedExecution("The turn is not running");
						const row = yield* lockedCall(
							and(
								eq(toolCall.turnId, runsTurn.turn.value),
								eq(toolCall.chatId, runsTurn.chat),
								eq(toolCall.messageId, scope.messageId),
								eq(toolCall.sdkToolCallId, input.sdkToolCallId),
								eq(toolCall.status, "awaiting_approval"),
							),
						);
						// Every call bound to an approval was parked for a member to allow first.
						if (!row) return { _tag: "NoPendingApproval" };
						const refuse = (reason: string) =>
							Effect.gen(function* () {
								const failed = yield* apply(
									row,
									ToolCallEvent.Abandon({ userMessage: APPROVAL_NO_LONGER_APPLIES }),
								);
								if (failed) yield* emit([ChatEvent.ToolCallFinished(toolCallChange(failed))]);
								return refusedExecution(reason);
							});
						const { binding } = input;
						if (binding.kind === "connector") {
							const [approvedConnector] = yield* query((db) =>
								db
									.select({ toolAccess: connector.toolAccess })
									.from(connector)
									.where(
										and(
											eq(connector.id, binding.connectorId),
											eq(connector.workspaceId, scope.workspaceId),
											// The project's or the bot's own: one of the projects it is in.
											exists(
												db
													.select({ projectId: projectBot.projectId })
													.from(projectBot)
													.where(
														and(
															eq(projectBot.projectId, connector.projectId),
															eq(projectBot.botId, scope.botId),
														),
													),
											),
											eq(connector.configurationRevision, binding.connectorRevision),
										),
									)
									.limit(1),
							);
							if (!approvedConnector) {
								return yield* refuse(APPROVED_CONNECTOR_CHANGED);
							}
							// Choosing what bots may do with a tool leaves the revision alone, so
							// a tool somebody turned off after the approval is caught here.
							if (approvedConnector.toolAccess[binding.remoteToolName] === "off") {
								return yield* refuse(APPROVED_TOOL_TURNED_OFF);
							}
						}
						if (!sameCallAsApproved(row, input)) {
							return refusedExecution(APPROVED_CALL_MISMATCH);
						}
						const running = yield* apply(row, ToolCallEvent.BeginExecution());
						if (!running) return refusedExecution("The call is not approved for execution");
						yield* emit([ChatEvent.ToolCallExecuting(toolCallChange(running))]);
						return { _tag: "Running", call: running };
					}),
				),
			),

		abandonUnfinished: (turnIds, userMessage) =>
			operation(
				"abandonUnfinished",
				transaction(
					Effect.gen(function* () {
						if (turnIds.length === 0) return;
						const unfinished = yield* query((db) =>
							db
								.select()
								.from(toolCall)
								.where(
									and(
										inArray(toolCall.turnId, [...turnIds]),
										inArray(toolCall.status, [...UNFINISHED_STATUSES]),
									),
								)
								.orderBy(toolCall.createdAt, toolCall.id)
								.for("update"),
						);
						const abandoned = yield* Effect.forEach(unfinished, (row) =>
							apply(
								row,
								ToolCallEvent.Abandon({
									userMessage:
										row.status === "running" && row.writeOrDelete ? INTERRUPTED_CALL : userMessage,
								}),
							),
						);
						yield* emit(
							abandoned.flatMap((row) =>
								row ? [ChatEvent.ToolCallFinished(toolCallChange(row))] : [],
							),
						);
					}),
				),
			),

		withdrawPending: (turnId, userMessage) =>
			operation(
				"withdrawPending",
				transaction(
					Effect.gen(function* () {
						const pending = yield* query((db) =>
							db
								.select()
								.from(toolCall)
								.where(and(eq(toolCall.turnId, turnId), eq(toolCall.approvalStatus, "pending")))
								.orderBy(toolCall.createdAt, toolCall.id)
								.for("update"),
						);
						const withdrawn = yield* Effect.forEach(pending, (row) =>
							apply(row, ToolCallEvent.Abandon({ userMessage })),
						);
						yield* emit(
							withdrawn.flatMap((row) =>
								row ? [ChatEvent.ToolCallFinished(toolCallChange(row))] : [],
							),
						);
						return withdrawn.flatMap((row) => (row?.approvalId ? [row.approvalId] : []));
					}),
				),
			),

		decisions: (turnId, approvalIds) =>
			operation(
				"decisions",
				Effect.map(
					query((db) =>
						approvalIds.length === 0
							? Effect.succeed([])
							: db
									.select({ approvalId: toolCall.approvalId, status: toolCall.approvalStatus })
									.from(toolCall)
									.where(
										and(
											eq(toolCall.turnId, turnId),
											inArray(toolCall.approvalId, [...approvalIds]),
										),
									),
					),
					(rows) =>
						new Map(
							rows.flatMap(({ approvalId, status }) =>
								approvalId && status ? [[approvalId, status] as const] : [],
							),
						),
				),
			),

		forgetReply: (messageId) =>
			operation(
				"forgetReply",
				query((db) => db.delete(toolCall).where(eq(toolCall.messageId, messageId))).pipe(
					Effect.asVoid,
				),
			),
	});
});

export const layer = processLayer(Layer.effect(Service, make));

/** Stored inputs and outputs are cut at this many characters of JSON. */
const MAX_STORED_JSON_CHARACTERS = 64_000;

type ToolCallOutcome = { output: unknown } | { error: UserText };

export const APPROVED_CALL_MISMATCH =
	"The call was already claimed, or no longer matches what was approved";
export const APPROVED_CONNECTOR_CHANGED = "The connector's configuration changed after approval";
export const APPROVED_TOOL_TURNED_OFF = "The tool was turned off after approval";

/** A tool call a reply asked for, to be parked until a member decides it. */
export interface PendingToolApproval {
	id: string;
	reopen?: boolean;
	approvalId: string;
	/** The step that made the call. */
	step: number;
	sdkToolCallId: string;
	tool: string;
	input: unknown;
	reason?: string;
	computerProjectId?: string | undefined;
	resolvedTargets?: ResolvedTargets | undefined;
	connectorAccess?: "allow" | "ask" | undefined;
	binding: ApprovalBinding;
	/** Whether the tool may change something, as opposed to one the connector's `ask` holds back. */
	writeOrDelete: boolean;
	atOffset: number;
}

/** A started call, or why it may not start; `reason` is for the logs. */
type BeganExecution =
	| { readonly _tag: "Running"; readonly call: ToolCallRow }
	| { readonly _tag: "NoPendingApproval" }
	| { readonly _tag: "Refused"; readonly reason: string };

/**
 * The value as JSON will keep it, cut down when it is too large to store. The
 * round trip through text is what drops `undefined` and anything else JSON
 * cannot carry; the cut keeps the start, which is where a page's title and a
 * result list's first entries are.
 */
export function inputShownInFull(input: unknown): boolean {
	return storedJsonText(input).length <= MAX_STORED_JSON_CHARACTERS;
}

/** The JSON a stored input or output is cut from. */
function storedJsonText(value: unknown): string {
	return JSON.stringify(value ?? null) ?? "null";
}

function boundedJson(value: unknown): JsonValue {
	const text = storedJsonText(value);
	if (text.length <= MAX_STORED_JSON_CHARACTERS) {
		return JSON.parse(text);
	}
	return {
		truncated: true,
		characters: text.length,
		preview: text.slice(0, MAX_STORED_JSON_CHARACTERS),
	};
}

export const replayWrittenFile = (fence: FencedProof, toolCallId: string) =>
	Effect.gen(function* () {
		const { receipt } = yield* fileWriteCall(fence, toolCallId, false);
		if (receipt) yield* transaction(holdTurnForToolWrite(fence));
		return receipt;
	});

/** commitWrittenFile saves the receipt with the file change while holding the turn's execution fence. */
export const commitWrittenFile = <E>(
	fence: FencedProof,
	toolCallId: string,
	write: Effect.Effect<FileWritten, E, Database | Transaction>,
) =>
	transaction(
		Effect.gen(function* () {
			yield* holdTurnForToolWrite(fence);
			// Lock the call before changing any file so concurrent retries share one receipt.
			const { receipt: replay } = yield* fileWriteCall(fence, toolCallId, true);
			if (replay) return { receipt: replay, usedContent: false };

			const receipt = yield* write;
			yield* query((db) =>
				db
					.update(toolCall)
					.set({ writtenFileReceipt: receipt })
					.where(fileWriteCallScope(fence, toolCallId)),
			);
			return { receipt, usedContent: true };
		}),
	);

const fileWriteCallScope = (fence: FencedProof, toolCallId: string) =>
	and(eq(toolCall.id, toolCallId), eq(toolCall.turnId, fence.turn.value));

const fileWriteCall = (fence: FencedProof, toolCallId: string, lock: boolean) =>
	Effect.gen(function* () {
		const [row] = yield* query((db) => {
			const select = db
				.select({ receipt: toolCall.writtenFileReceipt })
				.from(toolCall)
				.where(fileWriteCallScope(fence, toolCallId));
			return lock ? select.for("update") : select;
		});
		if (!row) return yield* new ApprovalRefused();
		return row;
	});

const lockedCall = (condition: SQL | undefined) =>
	Effect.map(
		query((db) => db.select().from(toolCall).where(condition).limit(1).for("update")),
		([row]) => row,
	);

function stateOf(row: ToolCallRow): ToolCallState {
	return {
		status: row.status,
		approvalStatus: row.approvalStatus,
		decidedById: row.decidedById,
		output: row.output,
		error: row.error,
	};
}

function refusedExecution(reason: string): BeganExecution {
	return { _tag: "Refused", reason };
}

/** sameCallAsApproved reports whether the call about to run is the one a member saw and allowed. */
function sameCallAsApproved(
	row: ToolCallRow,
	input: {
		tool: string;
		input: unknown;
		binding: ApprovalBinding;
	},
): boolean {
	return (
		row.tool === input.tool &&
		isDeepStrictEqual(
			{
				connectorId: row.connectorId,
				connectorRevision: row.connectorRevision,
				remoteToolName: row.remoteToolName,
			},
			bindingColumns(input.binding),
		) &&
		sameExecutionInput({ ...row, executionInput: row.executionInput ?? row.input }, input.input)
	);
}

/**
 * sameCallAsSent reports whether `current` is the call recorded as `row`:
 * the same tool, bound as it was, with the same input, and still classed as
 * changing nothing if it was. A call that fails this is not sent again.
 */
export function sameCallAsSent(
	row: ToolCallRow,
	current: { tool: string; input: unknown; binding: ApprovalBinding; writeOrDelete: boolean },
): boolean {
	return (
		row.tool === current.tool &&
		row.writeOrDelete === current.writeOrDelete &&
		isDeepStrictEqual(
			{
				connectorId: row.connectorId,
				connectorRevision: row.connectorRevision,
				remoteToolName: row.remoteToolName,
			},
			bindingColumns(current.binding),
		) &&
		sameExecutionInput(row, current.input)
	);
}

function sameExecutionInput(row: ToolCallRow, input: unknown): boolean {
	return sameRecordedInput(row.tool, row.executionInput, input, {
		builtIn: row.connectorId === null,
	});
}

/** How a binding is stored on the call: a built-in tool's leaves the connector's columns empty. */
function bindingColumns(binding: ApprovalBinding) {
	return binding.kind === "connector"
		? {
				connectorId: binding.connectorId,
				connectorRevision: binding.connectorRevision,
				remoteToolName: binding.remoteToolName,
			}
		: { connectorId: null, connectorRevision: null, remoteToolName: null };
}

/** The call as an event carries it once it has changed. */
function toolCallChange(row: ToolCallRow, decidedByName: string | null = null): ToolCallChange {
	return {
		chatId: row.chatId,
		messageId: row.messageId,
		toolCall: toToolCallPart(row, decidedByName),
	};
}
