export * as TurnRecords from "./records.ts";

import { chatStream, streamEvent } from "@sugabots/contracts";
import type {
	ApprovalAsked,
	ApprovalBinding,
	CallPlan,
	CallRecord,
	DecidedStepApproval,
	OfferedTool,
	RequestedCall,
	StepCall,
	ToolResultOutput,
	TurnEnding,
	TurnEnvironment,
	TurnSetting,
} from "@sugabots/contracts/turns";
import { type DomainError, type UserText, userText } from "@sugabots/errors";
import { jsonSchema, type ModelMessage, type ToolResultPart, type ToolSet, tool } from "ai";
import {
	Cause,
	Clock,
	Context,
	DateTime,
	Duration,
	Effect,
	Exit,
	Layer,
	Option,
	Ref,
	Schedule,
	Semaphore,
} from "effect";
import { type Database, transaction } from "../../database/database.ts";
import { EventBus } from "../../database/events/bus.ts";
import type { ToolCallRow } from "../../database/schema.ts";
import { ChatFileStore } from "../../files/chat-file-store.ts";
import { Ids } from "../../ids/ids.ts";
import type { EndsTurn } from "../../proofs/ends-turn.ts";
import type { RunsTurn } from "../../proofs/runs-turn.ts";
import { Models } from "../../providers/models/models.ts";
import { processLayer, Tier } from "../../tiers.ts";
import type { UserFacing } from "../../user-message.ts";
import { modelPrompt, steerPromptMessages } from "./context.ts";
import { TurnExecution } from "./execution.ts";
import { type FenceRefusal, holdRunningTurn } from "./fence.ts";
import { type LostEnding, type ReplyDraft, type TurnCheckpoint, TurnStore } from "./store.ts";
import { INTERRUPTED_CALL } from "./tool-calls/lifecycle.ts";
import { sameCallAsSent, ToolCallStore } from "./tool-calls/store.ts";

/**
 * What the bot loop records of a turn while it runs, each part demanding
 * that the principal runs the turn (`RunsTurn`): loading the turn for a step,
 * the step's model request, its tool calls and their results, asking for
 * approvals, and ending the turn. The loop's own operations, `turns.*`, are
 * built from this; nothing else calls it.
 */
export interface Interface {
	/**
	 * Loads the turn for its step `step`: where it is, and what its last step
	 * left. A turn that waited for approvals runs on once every one is decided;
	 * one whose approvals aren't all decided still waits.
	 */
	readonly load: <P, T>(
		runsTurn: RunsTurn<P, T>,
		step: number,
	) => Effect.Effect<LoadedStep, FenceRefusal>;
	/**
	 * Makes the step's model request: sends the model the turn's prompt and
	 * every earlier step's messages with `tools` on offer, sends the reply to
	 * the chat as it is written, and stores the step's text and the tool calls
	 * it made. The provider's credential is opened, and the request and its
	 * cost recorded in the ledger, by `Models`. A request that fails says how,
	 * and whether running the turn again could help.
	 */
	readonly makeModelRequest: <P, T>(
		runsTurn: RunsTurn<P, T>,
		request: {
			readonly step: number;
			readonly environment: TurnEnvironment;
			readonly tools: readonly OfferedTool[];
			readonly lastStep: boolean;
		},
	) => Effect.Effect<ModelRequestOutcome, FenceRefusal>;
	/**
	 * Records that the turn is sending its step's tool call `toolCallId`, before
	 * it is sent, and places it in the reply where the reply's text has
	 * reached. A call that may change something marks the turn as having
	 * acted, so it isn't run again from the start.
	 *
	 * A call is recorded once (see `CallRecord`): one an earlier execution of
	 * the turn recorded is sent again only if it finished nothing and changes
	 * nothing; one that may have changed something and never finished is
	 * recorded as interrupted.
	 */
	readonly recordToolCall: <P, T>(
		runsTurn: RunsTurn<P, T>,
		call: {
			readonly step: number;
			readonly toolCallId: string;
			readonly tool: string;
			readonly input: unknown;
			readonly writeOrDelete: boolean;
			readonly binding: ApprovalBinding;
		},
	) => Effect.Effect<CallRecord, FenceRefusal>;
	/**
	 * Keeps how each of the step's calls is to be made, before any of them is
	 * sent (see `CallPlan`).
	 */
	readonly planToolCalls: <P, T>(
		runsTurn: RunsTurn<P, T>,
		plans: ReadonlyArray<{ readonly toolCallId: string; readonly plan: CallPlan }>,
	) => Effect.Effect<void, FenceRefusal>;
	/** Records what the recorded call `callId` returned, or how it failed. */
	readonly finishToolCall: <P, T>(
		runsTurn: RunsTurn<P, T>,
		callId: string,
		outcome: { readonly output: unknown } | { readonly error: UserText },
	) => Effect.Effect<void, FenceRefusal>;
	/** Records that a permitted write has reached dispatch. */
	readonly markActed: <P, T>(runsTurn: RunsTurn<P, T>) => Effect.Effect<void, FenceRefusal>;
	/**
	 * Starts a call an approver allowed (see `ToolCallStore.beginExecution`),
	 * or says what became of it if an earlier execution of the turn started it,
	 * as `recordToolCall` does.
	 */
	readonly startApprovedToolCall: <P, T>(
		runsTurn: RunsTurn<P, T>,
		call: {
			readonly toolCallId: string;
			readonly tool: string;
			readonly input: unknown;
			readonly binding: ApprovalBinding;
		},
	) => Effect.Effect<
		CallRecord | { readonly _tag: "Refused"; readonly reason: string },
		FenceRefusal
	>;
	/**
	 * Parks the turn until its approvers decide the step's calls that wait for
	 * approval. Says which approvals it waits for, or that it may not wait: it
	 * was asked to stop, or its automation run takes no more turns.
	 */
	readonly askForApprovals: <P, T>(
		runsTurn: RunsTurn<P, T>,
		step: number,
		approvals: ReadonlyArray<
			ApprovalAsked & {
				readonly toolCallId: string;
				readonly reopenCallId?: string | undefined;
			}
		>,
	) => Effect.Effect<
		| { readonly _tag: "Waiting"; readonly approvals: readonly string[] }
		| { readonly _tag: "NotWaiting" },
		FenceRefusal
	>;
	/** Records what the model is given back for some of the step's tool calls (see `TurnStore.recordToolResults`). */
	readonly recordToolResults: <P, T>(
		runsTurn: RunsTurn<P, T>,
		results: ReadonlyArray<{ readonly toolCallId: string; readonly output: ToolResultOutput }>,
	) => Effect.Effect<void, FenceRefusal>;
	/**
	 * Ends the turn's run as `ending` says. An answer completes the reply; one
	 * that says nothing and carries no file lets an optional turn stay silent,
	 * and fails any other. Says whether a failed turn runs again, and whether an
	 * answer came too soon: a steer reached the turn that no step has read, so
	 * the turn takes another step to read it rather than end.
	 */
	readonly end: <P, T>(
		runsTurn: RunsTurn<P, T>,
		ending: TurnEnding,
	) => Effect.Effect<{ readonly willRetry: boolean; readonly steered: boolean }, FenceRefusal>;
	/**
	 * Ends a turn whatever its principal still reaches (see
	 * `TurnStore.endLost`). Refused once the turn ended or a newer execution
	 * took it over.
	 */
	readonly endLost: <P, T>(
		endsTurn: EndsTurn<P, T>,
		ending: LostEnding,
	) => Effect.Effect<void, FenceRefusal>;
}

export class Service extends Context.Service<Service, Interface>()("@sugabots/core/TurnRecords") {
	declare readonly [Tier]: "process";
}

/** What loading a turn for its step found. */
type LoadedStep =
	| {
			readonly _tag: "Begun";
			readonly setting: TurnSetting;
			readonly replyMessageId: string;
			/** Whether the step's model request was already made, before a restart. */
			readonly requested: boolean;
			readonly calls: readonly StepCall[];
			/** The step that made `calls`, which they are recorded under. */
			readonly callsStep: number;
			readonly recordedCallIds: readonly string[];
			readonly approvals: readonly DecidedStepApproval[];
			/** Whether the step's model request answered without calling a tool. */
			readonly answered: boolean;
			/** Whether a steer reached the turn that no step has read yet. */
			readonly steered: boolean;
	  }
	| { readonly _tag: "Waiting"; readonly approvals: readonly string[] }
	| { readonly _tag: "Ended" };

/** How a step's model request ended. */
type ModelRequestOutcome =
	| { readonly _tag: "Answered" }
	| { readonly _tag: "CalledTools"; readonly calls: readonly RequestedCall[] }
	| {
			readonly _tag: "Failed";
			readonly userMessage: UserText;
			readonly mayRunAgain: boolean;
			readonly retryAfterMillis?: number;
	  };

/** Token deltas are batched so a fast model does not publish per token. */
const DELTA_PUBLISH_INTERVAL = Duration.millis(50);
/** The reply so far is saved this often while it is written, so a crash loses little. */
const MESSAGE_FLUSH_INTERVAL = Duration.seconds(1);
/** ...and also whenever this much new text has arrived. */
const MESSAGE_FLUSH_CHARACTERS = 500;

export const make = Effect.gen(function* () {
	const turns = yield* TurnStore.Service;
	const toolCalls = yield* ToolCallStore.Service;
	const execution = yield* TurnExecution.Service;
	const files = yield* ChatFileStore.Service;
	const models = yield* Models.Service;
	const events = yield* EventBus.Service;
	const ids = yield* Ids.Service;
	const database = yield* Effect.context<Database>();

	/** The steers of the turn `turnId` that no step of it has read, by its checkpoint. */
	const unreadSteers = (turnId: string, checkpoint: TurnCheckpoint | undefined) =>
		Effect.map(execution.steers(turnId), (steers) => {
			const read = new Set(checkpoint?.steersRead ?? []);
			return steers.filter(({ id }) => !read.has(id));
		});

	const load: Interface["load"] = (runsTurn, step) =>
		Effect.gen(function* () {
			const begun = yield* turns.beginStep(runsTurn, step);
			if (begun._tag !== "Begun") return begun;
			const setting = yield* execution.context(runsTurn.turn.value);
			const bound = begun.checkpoint?.approvals ?? [];
			const decided = yield* toolCalls.decisions(
				runsTurn.turn.value,
				bound.map(({ approvalId }) => approvalId),
			);
			const withdrawn = new Set(begun.checkpoint?.withdrawnApprovals ?? []);
			const calls = begun.checkpoint?.calls ?? [];
			const callsStep = Math.max(0, (begun.checkpoint?.steps ?? 1) - 1);
			const recordedCallIds = calls.some((call) => call.result === undefined)
				? yield* toolCalls.recordedCallIds(runsTurn.turn.value, callsStep)
				: [];
			const loaded: LoadedStep = {
				_tag: "Begun",
				setting,
				replyMessageId: begun.reply.messageId,
				requested: (begun.checkpoint?.steps ?? 0) > step,
				calls,
				callsStep,
				recordedCallIds,
				approvals: bound.map((approval) => {
					const decision = withdrawn.has(approval.approvalId)
						? "withdrawn"
						: decided.get(approval.approvalId);
					return {
						...approval,
						decision:
							decision === "allowed" || decision === "denied" || decision === "withdrawn"
								? decision
								: "pending",
					};
				}),
				answered: begun.checkpoint?.answered ?? false,
				steered: (yield* unreadSteers(runsTurn.turn.value, begun.checkpoint)).length > 0,
			};
			return loaded;
		});

	const makeModelRequest: Interface["makeModelRequest"] = (runsTurn, request) =>
		Effect.uninterruptibleMask((restore) =>
			Effect.gen(function* () {
				const { reply: replyTurn, checkpoint } = yield* turns.current(runsTurn);
				const turnId = runsTurn.turn.value;
				const modelInput =
					checkpoint?.modelInput ??
					(yield* Effect.gen(function* () {
						const context = yield* execution.context(turnId);
						const resultFiles = yield* files.resultFiles(runsTurn.chat);
						const now = yield* DateTime.nowAsDate;
						const prompt = modelPrompt(context, { now, ...request.environment }, resultFiles);
						return { model: context.bot.model, ...prompt };
					}));
				// Steers that reached the turn since its last step are read now, after
				// what that step was given back.
				const steers = yield* unreadSteers(turnId, checkpoint);
				const steerMessages: readonly ModelMessage[] =
					steers.length === 0
						? []
						: steerPromptMessages(steers, {
								botId: replyTurn.botId,
								usesComputer: (yield* execution.context(turnId)).bot.usesComputer,
							}).map(({ role, content }) => ({ role, content }));
				const draft = yield* Ref.make<ReplyDraft>(
					checkpoint?.reply ?? { content: "", toolCalls: [] },
				);
				// One writer at a time: the periodic save and the on-size save must
				// not interleave, or an older draft could land after a newer one.
				const oneWriter = yield* Semaphore.make(1);
				const lastSaved = yield* Ref.make(yield* Ref.get(draft));
				const saveReply = oneWriter.withPermits(1)(
					Effect.gen(function* () {
						const now = yield* Ref.get(draft);
						if (now === (yield* Ref.get(lastSaved))) return;
						yield* turns.saveReply(runsTurn, now);
						yield* Ref.set(lastSaved, now);
					}),
				);
				const streamed = yield* Effect.exit(
					restore(
						Effect.scoped(
							Effect.gen(function* () {
								const generated = yield* models.stream({
									workspaceId: runsTurn.workspace,
									purpose: {
										name: "bot-turn",
										botId: replyTurn.botId,
										chatId: runsTurn.chat,
										turnId,
									},
									model: modelInput.model,
									system: modelInput.system,
									messages: modelInput.messages,
									continuationMessages: [...(checkpoint?.messages ?? []), ...steerMessages],
									tools: offered(request.tools),
									lastRequest: request.lastStep,
									step: request.step,
								});
								const publishing = consumeDeltas(
									{
										chatId: runsTurn.chat,
										messageId: replyTurn.messageId,
										execution: runsTurn.execution,
										step: request.step,
									},
									generated.deltas,
									events,
									draft,
									saveReply,
								);
								const periodicSave = saveReply.pipe(
									Effect.repeat(Schedule.spaced(MESSAGE_FLUSH_INTERVAL)),
									Effect.andThen(Effect.never),
								);
								yield* Effect.raceFirst(publishing, periodicSave);
								return yield* generated.finished;
							}),
						),
					),
				);
				const written = yield* Ref.get(draft);
				if (Exit.isFailure(streamed)) {
					// What was written stays, whatever stopped the request, unless the
					// fence refuses it: then the turn ended, or carries on elsewhere.
					yield* turns.keepReply(runsTurn, written).pipe(Effect.ignore);
					const cause = streamed.cause;
					const ended = Cause.findErrorOption(cause).pipe(
						Option.filter(
							(failure): failure is FenceRefusal =>
								failure._tag === "TurnEnded" || failure._tag === "TurnExecutionSuperseded",
						),
					);
					if (Option.isSome(ended)) return yield* Effect.fail(ended.value);
					if (Cause.hasInterruptsOnly(cause)) return yield* Effect.interrupt;
					return yield* requestFailed(runsTurn, cause);
				}
				const finished = streamed.value;
				yield* turns.recordModelRequest(runsTurn, {
					modelInput,
					messages: finished.responseMessages,
					steers: { ids: steers.map(({ id }) => id), messages: steerMessages },
					reply: written,
					contextTokens: finished.contextTokens,
					calls: finished.toolCalls,
					last: request.lastStep,
				});
				// The last step's calls are never made: what it wrote is the answer.
				if (finished.toolCalls.length === 0 || request.lastStep) {
					return { _tag: "Answered" } as const;
				}
				return { _tag: "CalledTools", calls: finished.toolCalls } as const;
			}),
		).pipe(Effect.provideContext(database));

	/**
	 * What became of a call an earlier execution of the turn, or this one,
	 * recorded, which `current` asks to send again: what it finished with; for
	 * one never finished that may have changed something, interrupted, which
	 * it is recorded as now; for one whose tool changed since, or that changes
	 * something now, not sent, and recorded as cut short; and otherwise sent
	 * again under the same record, once by each execution.
	 */
	const recordedBefore = <P, T>(
		runsTurn: RunsTurn<P, T>,
		row: ToolCallRow,
		current: {
			readonly tool: string;
			readonly input: unknown;
			readonly binding: ApprovalBinding;
			readonly writeOrDelete: boolean;
		},
	) =>
		Effect.gen(function* (): Effect.fn.Return<CallRecord, FenceRefusal, Database> {
			if (row.status === "completed") {
				return { _tag: "Finished", id: row.id, outcome: { output: row.output } };
			}
			if (row.status === "failed") {
				return {
					_tag: "Finished",
					id: row.id,
					outcome: { error: row.error ?? TOOL_CALL_FAILED },
				};
			}
			if (row.status === "awaiting_approval") {
				return { _tag: "NotSent", id: row.id, error: AWAITS_APPROVAL };
			}
			if (row.writeOrDelete) {
				yield* toolCalls.interrupt(runsTurn, row.id, INTERRUPTED_CALL);
				return { _tag: "Interrupted", id: row.id, error: INTERRUPTED_CALL };
			}
			if (!sameCallAsSent(row, current)) {
				yield* toolCalls.interrupt(runsTurn, row.id, CHANGED_SINCE_SENT);
				return { _tag: "NotSent", id: row.id, error: CHANGED_SINCE_SENT };
			}
			if (!(yield* toolCalls.claim(runsTurn, row.id))) {
				return { _tag: "NotSent", id: row.id, error: SENT_ALREADY };
			}
			return { _tag: "Send", id: row.id };
		});

	/**
	 * Ends the run of a turn whose model request answered, once its row is
	 * locked, so a steer or an interrupt either reaches it before this or finds
	 * it ended: one interrupted ends interrupted, and a steer no step has read
	 * leaves the turn to take another step instead.
	 */
	const endAnswered = <P, T>(runsTurn: RunsTurn<P, T>, noMoreSteps: boolean) =>
		Effect.gen(function* () {
			const ended = { willRetry: false, steered: false };
			yield* holdRunningTurn(runsTurn, "update");
			// Asked to end after the step's answer came and before the step heard:
			// it ends as asked, not answered, so its mentions start no helpers.
			if (yield* turns.endRequested(runsTurn)) {
				yield* turns.cancel(runsTurn);
				return ended;
			}
			const { reply, checkpoint } = yield* turns.current(runsTurn);
			const steered = (yield* unreadSteers(runsTurn.turn.value, checkpoint)).length > 0;
			if (steered && !noMoreSteps) return { willRetry: false, steered: true };
			const context = yield* execution.context(runsTurn.turn.value);
			const completion = {
				contextTokens: checkpoint?.contextTokens,
				contextCapacity: context.windowTokens,
				readKeptFrom: context.compaction?.keptFrom.toISOString() ?? null,
				// Steers it may take no more steps to read each start a turn of their own.
				handsOnUnreadSteers: steered,
			};
			const answered = (checkpoint?.reply.content ?? "").trim() !== "";
			// Files the bot shared answer as words do. Looked up only when nothing else answered.
			if (answered || (yield* turns.replyFiles(reply)).length > 0) {
				yield* turns.complete(runsTurn, completion);
				return ended;
			}
			// Writing nothing is how a bot declines an optional turn.
			if (context.reason === "optional") {
				yield* turns.staySilent(runsTurn, completion);
				return ended;
			}
			const failure = new ReplyWithoutAnswer();
			yield* logTurnFailure(runsTurn, failure.message);
			yield* turns.fail(runsTurn, { userMessage: failure.userMessage, mayRunAgain: false });
			return ended;
		});

	return Service.of({
		load: (runsTurn, step) => load(runsTurn, step).pipe(Effect.provideContext(database)),
		makeModelRequest,
		recordToolCall: (runsTurn, call) =>
			transaction(
				Effect.gen(function* () {
					const sent = yield* toolCalls.sent(runsTurn, call);
					if (sent) return yield* recordedBefore(runsTurn, sent, call);
					const id = yield* ids.next;
					const atOffset = yield* turns.placeToolCall(runsTurn, id);
					const { reply } = yield* turns.current(runsTurn);
					const opened = yield* toolCalls.open(runsTurn, {
						id,
						chatId: runsTurn.chat,
						messageId: reply.messageId,
						step: call.step,
						toolCallId: call.toolCallId,
						tool: call.tool,
						input: call.input,
						atOffset,
						writeOrDelete: call.writeOrDelete,
						binding: call.binding,
					});
					// The turn's row is locked, so no other execution recorded it since.
					if (!opened) return yield* Effect.die(new Error("A tool call was recorded twice"));
					if (call.writeOrDelete && call.binding.kind === "built-in")
						yield* turns.markActed(runsTurn);
					return { _tag: "Send", id } satisfies CallRecord;
				}),
			).pipe(Effect.provideContext(database)),
		markActed: turns.markActed,
		planToolCalls: (runsTurn, plans) => turns.planCalls(runsTurn, plans),
		finishToolCall: (runsTurn, callId, outcome) =>
			Effect.asVoid(toolCalls.close(runsTurn, callId, outcome)),
		startApprovedToolCall: (runsTurn, call) =>
			transaction(
				Effect.gen(function* () {
					const began = yield* toolCalls.beginExecution(runsTurn, {
						sdkToolCallId: call.toolCallId,
						tool: call.tool,
						input: call.input,
						binding: call.binding,
					});
					if (began._tag === "Running") {
						if (began.call.writeOrDelete && call.binding.kind === "built-in")
							yield* turns.markActed(runsTurn);
						yield* toolCalls.claim(runsTurn, began.call.id);
						return { _tag: "Send", id: began.call.id } satisfies CallRecord;
					}
					if (began._tag === "Refused") return began;
					// An allowed call an earlier execution, or this one, already started.
					const started = yield* toolCalls.sent(runsTurn, { toolCallId: call.toolCallId });
					return started?.approvalStatus === "allowed" && started.status !== "awaiting_approval"
						? yield* recordedBefore(runsTurn, started, {
								...call,
								writeOrDelete: started.writeOrDelete,
							})
						: ({ _tag: "Refused", reason: MISSING_APPROVAL_RECORD } as const);
				}),
			).pipe(Effect.provideContext(database)),
		askForApprovals: (runsTurn, step, approvals) =>
			Effect.gen(function* () {
				const pending = yield* Effect.forEach(approvals, (approval) =>
					Effect.gen(function* () {
						const call: ToolCallStore.PendingToolApproval = {
							id: approval.reopenCallId ?? (yield* ids.next),
							reopen: approval.reopenCallId !== undefined,
							approvalId: yield* ids.next,
							step,
							sdkToolCallId: approval.toolCallId,
							tool: approval.tool,
							input: approval.input,
							...(approval.reason === undefined ? {} : { reason: approval.reason }),
							computerProjectId: approval.computerProjectId,
							connectorAccess: approval.connectorAccess,
							binding: approval.binding,
							writeOrDelete: approval.writeOrDelete,
							atOffset: 0,
						};
						return call;
					}),
				);
				const suspended = yield* turns.suspend(
					runsTurn,
					pending,
					pending.map(({ approvalId, sdkToolCallId, tool, binding }) => ({
						approvalId,
						toolCallId: sdkToolCallId,
						tool,
						binding,
					})),
				);
				return suspended
					? ({ _tag: "Waiting", approvals: pending.map(({ approvalId }) => approvalId) } as const)
					: ({ _tag: "NotWaiting" } as const);
			}),
		recordToolResults: (runsTurn, results) =>
			turns.recordToolResults(
				runsTurn,
				results.map(({ toolCallId, output }) => ({
					toolCallId,
					// The loop gives back what the tool's own `toModelOutput`, or the SDK's rule, made.
					output: output as ToolResultPart["output"],
				})),
			),
		end: (runsTurn, ending) =>
			Effect.gen(function* () {
				switch (ending.kind) {
					case "cancelled":
						yield* turns.cancel(runsTurn);
						return { willRetry: false, steered: false };
					case "failed":
						return { willRetry: yield* turns.fail(runsTurn, ending), steered: false };
					case "answered":
						return yield* transaction(endAnswered(runsTurn, ending.noMoreSteps ?? false));
				}
			}).pipe(Effect.provideContext(database)),
		endLost: (endsTurn, ending) => turns.endLost(endsTurn, ending),
	});
});

export const layerNoDeps = processLayer(Layer.effect(Service, make));

export const layer = layerNoDeps.pipe(
	Layer.provide([TurnStore.layer, ToolCallStore.layer, TurnExecution.layer, ChatFileStore.layer]),
);

/**
 * The tools a step offers, as its model request sends them: each one's
 * description and input schema, and nothing to run it with, so the request
 * returns the model's calls rather than making them.
 */
function offered(tools: readonly OfferedTool[]): ToolSet {
	return Object.fromEntries(
		tools.map((offeredTool) => [
			offeredTool.name,
			tool({
				...(offeredTool.description === undefined ? {} : { description: offeredTool.description }),
				inputSchema: jsonSchema(offeredTool.inputSchema),
			}),
		]),
	);
}

/**
 * Logs why a model request failed and says what the loop records of it: the
 * turn runs again only while that is safe and could help. A request that
 * would fail the same way again does not, nor one that asks to be left
 * longer than a turn should wait. A defect is logged in full and told as
 * the reply stopping unexpectedly.
 */
const requestFailed = <P, T>(runsTurn: RunsTurn<P, T>, cause: Cause.Cause<unknown>) =>
	Effect.gen(function* () {
		const expected = Cause.findErrorOption(cause).pipe(Option.filter(Models.isRequestFailure));
		if (Option.isNone(expected)) {
			yield* Effect.logError("A turn's model request died", cause);
			return {
				_tag: "Failed",
				userMessage: TURN_STOPPED_UNEXPECTEDLY,
				mayRunAgain: true,
			} satisfies ModelRequestOutcome;
		}
		// Every request failure says whether to try again, and how long the provider asked to be left.
		const failure: DomainError = expected.value;
		yield* logTurnFailure(runsTurn, failure.message);
		const waitsTooLong =
			failure.retryAfter !== undefined &&
			Duration.isGreaterThan(failure.retryAfter, Models.MAX_RATE_LIMIT_WAIT);
		return {
			_tag: "Failed",
			userMessage: failure.userMessage,
			mayRunAgain: failure.isRetryable && !waitsTooLong,
			...(failure.retryAfter === undefined
				? {}
				: { retryAfterMillis: Duration.toMillis(failure.retryAfter) }),
		} satisfies ModelRequestOutcome;
	});

/** Enough in the server log to find the turn. */
const logTurnFailure = <P, T>(runsTurn: RunsTurn<P, T>, why: string) =>
	Effect.logError(`Turn ${runsTurn.turn.value} failed: ${why}`, `(chat ${runsTurn.chat})`);

/**
 * What members, and the model, are told of a call that may change things,
 * which an execution of the turn sent and never saw finish, as when its
 * process stopped: it is not sent again.
 */

export const MISSING_APPROVAL_RECORD = "The call has no approval record";

/** What a call is told when its tool changed since an execution sent it, so it isn't sent again. */
export const CHANGED_SINCE_SENT = userText`This call was cut short, and its tool has changed since, so it wasn't sent again. Check what it did before asking for it again.`;

/** What a call is told that this execution of the turn has sent already. */
const SENT_ALREADY = userText`This call was sent already, so it wasn't sent again.`;

/** What a call is told that still waits for its approvers. */
const AWAITS_APPROVAL = userText`This call waits for approval, so it wasn't sent.`;

/** What a failed call is told as when it was recorded without saying why. */
const TOOL_CALL_FAILED = userText`The tool failed before it finished.`;

/** What members are told of a turn a defect ended, rather than a failure it expects. */
const TURN_STOPPED_UNEXPECTEDLY = userText`The reply stopped unexpectedly.`;

/** The model finished without writing anything or asking anyone. */
class ReplyWithoutAnswer extends Error implements UserFacing {
	override readonly message = "Model finished without an answer";
	get userMessage() {
		return userText`The reply stopped before answering.`;
	}
}

/**
 * Appends each delta to the reply, publishing batched deltas to live
 * subscribers and saving when enough new text has arrived.
 */
const consumeDeltas = <E, R>(
	reply: {
		readonly chatId: string;
		readonly messageId: string;
		readonly execution: number;
		readonly step: number;
	},
	deltas: AsyncIterable<Models.Delta>,
	events: Pick<EventBus.Interface, "publish">,
	draft: Ref.Ref<ReplyDraft>,
	saveReply: Effect.Effect<void, E, R>,
) =>
	Effect.gen(function* () {
		let pending: (Models.Delta & { offset: number }) | undefined;
		let lastPublishedAt = 0;
		let unsavedCharacters = 0;

		const publishPending = Effect.suspend(() => {
			const delta = pending;
			pending = undefined;
			return delta ? publishDelta(reply, delta, events) : Effect.void;
		});

		yield* Models.forEachDelta(deltas, (delta) =>
			Effect.gen(function* () {
				if (!delta.text) return;
				if (pending && pending.kind !== delta.kind) yield* publishPending;
				const current = yield* Ref.get(draft);
				const { reply: updated, offset } = appendDelta(current, reply.step, delta);
				yield* Ref.set(draft, updated);
				pending = {
					kind: delta.kind,
					offset: pending?.offset ?? offset,
					text: (pending?.text ?? "") + delta.text,
				};
				const now = yield* Clock.currentTimeMillis;
				if (now - lastPublishedAt >= Duration.toMillis(DELTA_PUBLISH_INTERVAL)) {
					lastPublishedAt = now;
					yield* publishPending;
				}
				unsavedCharacters += delta.text.length;
				if (unsavedCharacters >= MESSAGE_FLUSH_CHARACTERS) {
					unsavedCharacters = 0;
					yield* saveReply;
				}
			}),
		);
		yield* publishPending;
		yield* saveReply;
	});

function appendDelta(draft: ReplyDraft, step: number, delta: Models.Delta) {
	if (delta.kind === "text") {
		return {
			reply: { ...draft, content: draft.content + delta.text },
			offset: draft.content.length,
		};
	}
	const thinking = draft.thinking ?? [];
	const last = thinking.at(-1);
	const previous = last?.step === step ? last : undefined;
	return {
		reply: {
			...draft,
			thinking: [
				...(previous ? thinking.slice(0, -1) : thinking),
				{ step, text: (previous?.text ?? "") + delta.text },
			],
		},
		offset: previous?.text.length ?? 0,
	};
}

/** publishDelta keeps the turn running if subscribers miss an ephemeral update. */
const publishDelta = (
	reply: {
		readonly chatId: string;
		readonly messageId: string;
		readonly execution: number;
		readonly step: number;
	},
	delta: Models.Delta & { offset: number },
	events: Pick<EventBus.Interface, "publish">,
) => {
	const { step, ...message } = reply;
	const payload = { ...message, offset: delta.offset, text: delta.text };
	const event =
		delta.kind === "thinking"
			? streamEvent("message.thinking_delta", { ...payload, step })
			: streamEvent("message.delta", payload);
	return Effect.promise(() => events.publish(chatStream(reply.chatId), event)).pipe(
		Effect.catchCause((cause) => Effect.logError("Publishing a message delta failed", cause)),
	);
};
