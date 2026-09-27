import { streamEvent, threadChannel } from "@sugabots/contracts";
import type { ToolSet } from "ai";
import {
	Cause,
	Clock,
	Data,
	Duration,
	Effect,
	Exit,
	Layer,
	Ref,
	Schedule,
	Semaphore,
} from "effect";
import { Database, effectRunner, transaction } from "../../database/database.ts";
import type { EventBus } from "../../database/events/bus.ts";
import { Lanes } from "../../workflows/lanes.ts";
import { describeFailure } from "../failure.ts";
import type { RoutineStore } from "../routines/store.ts";
import type { SummaryRequest } from "../summaries/summary.workflow.ts";
import { noToolApprovalStore, type ToolApprovalStore } from "../tools/approvals/store.ts";
import { type BuiltInTools, noBuiltInTools } from "../tools/built-in.ts";
import type { ToolCallStore } from "../tools/calls/store.ts";
import type { CollaborationStore } from "../tools/collaborate/store.ts";
import { type ConnectionTools, noConnectionTools } from "../tools/connections.ts";
import { toolsForTurn } from "../tools/for-turn.ts";
import { modelPrompt, type TurnEnvironment } from "./context.ts";
import { forEachDelta, type ModelAccounting, type TurnModel } from "./model.ts";
import {
	type ClaimedTurn,
	MAX_TURN_RUNS,
	type PreparedTurn,
	type ReplyDraft,
	retryable,
	type TurnCheckpoint,
	type TurnStore,
} from "./store.ts";
import {
	type SegmentOutcome,
	Turn,
	type TurnRequest,
	TurnSteps,
	turnLane,
} from "./turn.workflow.ts";

/** Token deltas are batched so a fast model does not publish per token. */
const DELTA_PUBLISH_INTERVAL = Duration.millis(50);
/** The reply so far is saved this often while streaming, so a crash loses little. */
const MESSAGE_FLUSH_INTERVAL = Duration.seconds(1);
/** ...and also whenever this much new text has arrived. */
const MESSAGE_FLUSH_CHARACTERS = 500;
/**
 * A running turn stops on `turn.cancel_requested`. The flag is also read this
 * often, from the start, for a request made before the worker subscribed or
 * relayed from a process whose relay is down.
 */
const CANCELLATION_CHECK_INTERVAL = Duration.seconds(15);
const TURN_TIMEOUT = Duration.minutes(10);

export interface TurnExecution {
	store: TurnStore;
	model: TurnModel;
	/** Behind the collaborate tool, and how a collaborator's answer reaches the asker. */
	collaborations: CollaborationStore;
	/** Where a built-in tool's calls are written down. */
	calls: ToolCallStore;
	approvals?: ToolApprovalStore;
	/** The built-in tools a workspace's crew turns are offered. */
	builtInTools?: BuiltInTools;
	/** The tools inherited from the agent's pod, opened for the turn (ADR 006). */
	connectionTools?: ConnectionTools;
	/** Where token deltas go, and where tools watch for things to happen. */
	events: Pick<EventBus, "publish" | "subscribe">;
	routines?: Pick<RoutineStore, "settleThread">;
	/** Asks the Scribe to catch up on the thread after a completed reply. */
	queueSummary: (request: SummaryRequest) => Effect.Effect<void>;
}

/** A turn workflow's run of its turn, owned by the execution. */
const claimFor = (request: TurnRequest, attempt: number) =>
	Effect.map(
		Turn.executionId(request),
		(owner): ClaimedTurn => ({
			owner,
			threadId: request.threadId,
			payload: {
				agentId: request.agentId,
				triggerMessageId: request.triggerMessageId,
				reason: request.reason,
			},
			attempts: attempt,
		}),
	);

/**
 * The turn workflow's steps: running a segment of the turn, and freeing its
 * lane afterwards. Activities reach them through `TurnSteps`.
 */
export const stepsLayer = (execution: TurnExecution & { approvals: ToolApprovalStore }) =>
	Layer.effect(
		TurnSteps,
		Effect.gen(function* () {
			const database = yield* Database;
			const lanes = yield* Lanes.Service;
			return TurnSteps.of({
				segment: (request, attempt) =>
					Effect.flatMap(claimFor(request, attempt), (claimed) =>
						runClaimedTurn(claimed, execution),
					).pipe(Effect.provideService(Database, database)),
				abandon: (request) =>
					transaction(
						Effect.gen(function* () {
							const error = "The turn stopped unexpectedly";
							yield* execution.store.abandon(yield* claimFor(request, 1), error);
							if (execution.routines) {
								yield* execution.routines.settleThread(request.threadId, {
									state: "failed",
									error,
								});
							}
						}),
					).pipe(Effect.provideService(Database, database)),
				decide: (request, approvalId, decision) =>
					execution.approvals
						.record({ threadId: request.threadId, approvalId, decision })
						.pipe(Effect.provideService(Database, database)),
				stopWaiting: (request) =>
					execution.store.stopWaiting(request).pipe(Effect.provideService(Database, database)),
				// A routine run cannot settle while its turn holds the lane, so the
				// run is settled again once the lane is free.
				release: (request) =>
					Effect.flatMap(Turn.executionId(request), (executionId) =>
						lanes.release({ key: turnLane(request), executionId }),
					).pipe(
						Effect.andThen(execution.routines?.settleThread(request.threadId) ?? Effect.void),
						Effect.provideService(Database, database),
					),
			});
		}),
	);

/**
 * Runs one segment of a claimed turn, from preparation to recorded outcome,
 * and says how it ended for the workflow.
 *
 * Preparing can end before there is anything to show for it: the turn ends if
 * it cannot run, or runs again if the database failed. After that the reply
 * is streamed, and whatever ends the stream is written back as the turn's
 * outcome.
 */
export const runClaimedTurn = (
	claimed: ClaimedTurn,
	execution: TurnExecution,
): Effect.Effect<SegmentOutcome, never, Database> =>
	execution.store.prepare(claimed).pipe(
		Effect.flatMap((prepared) => generateReply(prepared, execution)),
		Effect.catchTag("TurnNotRunnable", (why) =>
			Effect.as(
				execution.routines?.settleThread(
					claimed.threadId,
					why.terminalOutcome ?? { state: "cancelled" },
				) ?? Effect.void,
				finished,
			),
		),
		Effect.catchDefect((defect) => {
			if (runsAgain(claimed, true)) return Effect.succeed(retry);
			const error = describeFailure(defect);
			return transaction(
				Effect.gen(function* () {
					yield* execution.store.abandon(claimed, error);
					if (execution.routines) {
						yield* execution.routines.settleThread(claimed.threadId, { state: "failed", error });
					}
					return finished;
				}),
			);
		}),
	);

const finished: SegmentOutcome = { _tag: "Finished" };
const retry: SegmentOutcome = { _tag: "Retry" };

/**
 * Whether a failed segment runs again. `retryable` is false once the turn has
 * a checkpoint or a tool that changes things has run, since a retry could do
 * it again (ADR 002).
 */
const runsAgain = (claim: ClaimedTurn, retryable: boolean) =>
	retryable && claim.attempts < MAX_TURN_RUNS;

const emptyReply: ReplyDraft = { content: "", collaborations: [], toolCalls: [] };

type StreamOutcome =
	| { kind: "completed"; accounting: ModelAccounting }
	| {
			kind: "suspended";
			checkpoint: TurnCheckpoint;
			approvals: import("../tools/approvals/store.ts").PendingToolApproval[];
	  };

/** Why a reply stopped streaming before the model finished. */
class TurnCancelled extends Data.TaggedError("TurnCancelled") {
	override get message() {
		return "Turn cancelled";
	}
}
class TurnTimedOut extends Data.TaggedError("TurnTimedOut") {
	override get message() {
		return "Turn timed out";
	}
}
class ApprovedToolChanged extends Data.TaggedError("ApprovedToolChanged")<{
	readonly tool: string;
}> {
	override get message() {
		return `Approved tool ${this.tool} no longer has the reviewed configuration`;
	}
}
class ApprovalForUnknownTool extends Data.TaggedError("ApprovalForUnknownTool")<{
	readonly tool: string;
}> {
	override get message() {
		return `Approval requested for unknown tool ${this.tool}`;
	}
}

/**
 * Streams the model's reply into the response message and records how it ended.
 *
 * The streaming half may be interrupted: by a person cancelling, by the time
 * limit, or by the worker shutting down. The recording half may not, or the
 * turn would be left `running` and the message `streaming` forever. Hence the
 * mask: only the stream runs interruptibly, and whatever exit it produces is
 * written back before the fibre yields to the interrupt.
 */
const generateReply = (
	prepared: PreparedTurn,
	execution: TurnExecution,
): Effect.Effect<SegmentOutcome, never, Database> =>
	Effect.uninterruptibleMask((restore) =>
		Effect.gen(function* () {
			const { store, collaborations, routines } = execution;
			const reply = yield* Ref.make<ReplyDraft>(prepared.checkpoint?.reply ?? emptyReply);
			const streamed = yield* Effect.exit(restore(streamReply(prepared, execution, reply)));
			const draft = yield* Ref.get(reply);

			/** Records the failure; the segment runs again only while that is safe. */
			const failed = (error: string) =>
				transaction(
					Effect.gen(function* () {
						const willRetry = runsAgain(prepared.claim, retryable(prepared, draft));
						yield* store.fail(prepared, draft, error, willRetry);
						if (!willRetry && routines) {
							yield* routines.settleThread(prepared.context.thread.id, { state: "failed", error });
						}
						return willRetry ? retry : finished;
					}),
				);

			if (Exit.isSuccess(streamed)) {
				if (streamed.value.kind === "suspended") {
					const { checkpoint, approvals } = streamed.value;
					return yield* transaction(
						Effect.gen(function* () {
							if (yield* store.suspend(prepared, checkpoint, approvals)) {
								return {
									_tag: "Suspended",
									approvals: checkpoint.approvals.map((approval) => approval.approvalId),
								} satisfies SegmentOutcome;
							}
							yield* store.cancel(prepared, draft);
							if (routines) {
								yield* routines.settleThread(prepared.context.thread.id, { state: "cancelled" });
							}
							return finished;
						}),
					);
				}
				const accounting = streamed.value.accounting;
				// One transaction: the answer must be readable by the time anyone
				// hears the turn completed, or the asking agent wakes to nothing
				// and gives up waiting for an answer that lands a moment later.
				const answeredABrief = yield* transaction(
					Effect.gen(function* () {
						const answered = prepared.context.thread.parentThreadId
							? yield* collaborations
									.deliverAnswer({ threadId: prepared.context.thread.id, answer: draft.content })
									.pipe(
										Effect.catchCause((cause) =>
											Effect.sync(() => {
												console.error("Delivering a collaboration answer failed", cause);
												return false;
											}),
										),
									)
							: false;
						yield* store.complete(prepared, draft, accounting);
						if (!answered) {
							yield* store.giveFloor(prepared, draft);
						}
						if (routines) yield* routines.settleThread(prepared.context.thread.id);
						return answered;
					}),
				);
				// Answering a brief concludes that exchange: the answer has gone back
				// to the agent that asked, and it carries on in the parent. Deciding
				// who speaks next here as well left the two of them talking to each
				// other in the child thread, which nobody was reading.
				void answeredABrief;
				yield* execution
					.queueSummary({
						threadId: prepared.context.thread.id,
						agentId: prepared.context.agent.id,
						sourceMessageId: prepared.responseMessage.id,
					})
					.pipe(
						Effect.catchCause((cause) =>
							Effect.sync(() => console.error("Queueing a thread summary failed", cause)),
						),
					);
				return finished;
			}

			const cause = streamed.cause;
			if (Cause.hasInterruptsOnly(cause)) return yield* failed("Worker stopped");
			const failure = Cause.squash(cause);
			if (failure instanceof TurnCancelled) {
				return yield* transaction(
					Effect.gen(function* () {
						yield* store.cancel(prepared, draft);
						if (routines) {
							yield* routines.settleThread(prepared.context.thread.id, { state: "cancelled" });
						}
						return finished;
					}),
				);
			}
			const error = describeFailure(failure);
			yield* logTurnFailure(prepared, error);
			return yield* failed(error);
		}),
	);

/** Enough in the server log to find the turn and the provider it used. */
const logTurnFailure = (prepared: PreparedTurn, error: string) =>
	Effect.sync(() =>
		console.error(
			`Turn ${prepared.turnId} failed: ${error}`,
			`(thread ${prepared.context.thread.id}, agent ${prepared.context.agent.name}, model ${prepared.context.agent.model})`,
		),
	);

/**
 * Streams the reply into `reply`, publishing deltas and saving the text so far
 * as it goes, until the model finishes or something stops it.
 *
 * Three things run alongside the stream and race it: a poll for a person
 * asking to cancel, a periodic save of the reply so far, and the time limit.
 * Whichever ends first, however it ends, interrupts the others, and the model
 * is told to stop through the abort signal it was given.
 */
const streamReply = (
	prepared: PreparedTurn,
	{
		store,
		model,
		events,
		collaborations,
		calls,
		approvals = noToolApprovalStore,
		builtInTools = noBuiltInTools,
		connectionTools = noConnectionTools,
	}: TurnExecution,
	reply: Ref.Ref<ReplyDraft>,
): Effect.Effect<StreamOutcome, Error, Database> =>
	Effect.scoped(
		Effect.gen(function* () {
			const stop = new AbortController();
			yield* Effect.addFinalizer(() => Effect.sync(() => stop.abort()));

			// One writer at a time: the periodic save, the on-size save and a tool
			// marking the reply must not interleave, or an older draft could land
			// after a newer one.
			const oneWriter = yield* Semaphore.make(1);
			const lastSaved = yield* Ref.make<ReplyDraft>(emptyReply);
			const saveReply = oneWriter.withPermits(1)(saveReplySoFar(prepared, store, reply, lastSaved));

			// A tool runs inside the SDK as a promise, so it needs a way back to
			// this runtime's database.
			const context = yield* Effect.context<Database>();
			const now = new Date(yield* Clock.currentTimeMillis);
			const builtIn = withoutDisabled(
				yield* builtInTools.forWorkspace(prepared.context.thread.workspaceId),
				prepared.context.agent.disabledTools,
			);
			// The connections' sessions live as long as the turn.
			const connections = yield* Effect.acquireRelease(
				connectionTools.forPod(prepared.context.thread.workspaceId, prepared.context.agent.podId),
				(opened) => Effect.promise(() => opened.close()),
			);
			const approvalBoundTools = new Set<string>();
			for (const binding of prepared.checkpoint?.approvals ?? []) {
				const offered = connections.tools[binding.tool];
				if (
					!offered ||
					offered.connectionId !== binding.connectionId ||
					offered.connectionRevision !== binding.connectionRevision ||
					offered.remoteToolName !== binding.remoteToolName
				) {
					return yield* new ApprovedToolChanged({ tool: binding.tool });
				}
				approvalBoundTools.add(binding.tool);
			}
			const toolsNeedingApproval = Object.entries(connections.tools)
				.filter(([, offered]) => offered.requiresApproval)
				.map(([key]) => key);
			const tools = toolsForTurn(prepared, {
				collaborations,
				calls,
				approvals,
				approvalBoundTools,
				builtIn,
				connections: connections.tools,
				bus: events,
				run: effectRunner({ runPromiseExit: Effect.runPromiseExitWith(context) }),
				reply: {
					length: () => Ref.getUnsafe(reply).content.length,
					noteCollaboration: (collaboration) =>
						Ref.update(reply, (draft) => ({
							...draft,
							collaborations: [...draft.collaborations, collaboration],
						})).pipe(Effect.andThen(Effect.provideContext(saveReply, context))),
					noteToolCall: ({ id, atOffset }) =>
						Ref.update(reply, (draft) => ({
							...draft,
							toolCalls: draft.toolCalls.some((call) => call.id === id)
								? draft.toolCalls
								: [...draft.toolCalls, { id, atOffset }],
						})).pipe(Effect.andThen(Effect.provideContext(saveReply, context))),
					markActed: () =>
						Ref.update(reply, (draft) => ({ ...draft, acted: true })).pipe(
							Effect.andThen(Effect.provideContext(saveReply, context)),
						),
				},
				signal: stop.signal,
			});

			const environment: TurnEnvironment = {
				now,
				builtInTools: Object.keys(builtIn),
				connectionTools: Object.keys(connections.tools),
			};
			const freshPrompt = modelPrompt(prepared.context, environment);
			const modelInput =
				prepared.checkpoint?.modelInput ??
				({
					model: prepared.context.agent.model,
					system: freshPrompt.system,
					messages: freshPrompt.messages,
				} satisfies TurnCheckpoint["modelInput"]);
			const approvalResponse = prepared.checkpoint
				? yield* approvals.responsesForTurn(
						prepared.turnId,
						prepared.checkpoint.approvals.map(({ approvalId }) => approvalId),
					)
				: undefined;
			const priorMessages = prepared.checkpoint?.messages ?? [];
			const segmentMessages = approvalResponse
				? [...priorMessages, approvalResponse]
				: priorMessages;
			const generated = yield* model.stream({
				workspaceId: prepared.context.thread.workspaceId,
				model: modelInput.model,
				system: modelInput.system,
				messages: modelInput.messages,
				continuationMessages: segmentMessages,
				tools,
				toolApproval: Object.fromEntries(toolsNeedingApproval.map((key) => [key, "user-approval"])),
				maxSteps: Math.max(1, 8 - (prepared.checkpoint?.accounting.usage.modelCalls ?? 0)),
				signal: stop.signal,
			});

			const consume = Effect.gen(function* () {
				yield* consumeDeltas(prepared, generated.text, stop, events, reply, saveReply);
				yield* saveReply;
				const accounting = yield* generated.accounting;
				const terminal = generated.continuation ? yield* generated.continuation : undefined;
				if (!terminal || terminal.approvalRequests.length === 0) {
					return {
						kind: "completed" as const,
						accounting: addAccounting(prepared.checkpoint, accounting),
					};
				}
				const atOffset = (yield* Ref.get(reply)).content.length;
				const pending = terminal.approvalRequests.map((request) => {
					const offered = connections.tools[request.toolCall.toolName];
					if (!offered?.requiresApproval) {
						throw new ApprovalForUnknownTool({ tool: request.toolCall.toolName });
					}
					return {
						id: crypto.randomUUID(),
						approvalId: request.approvalId,
						sdkToolCallId: request.toolCall.toolCallId,
						tool: request.toolCall.toolName,
						input: request.toolCall.input,
						reason: request.reason,
						connectionId: offered.connectionId,
						connectionRevision: offered.connectionRevision,
						remoteToolName: offered.remoteToolName,
						mutating: offered.mutating,
						atOffset,
					};
				});
				yield* Ref.update(reply, (draft) => ({
					...draft,
					toolCalls: [
						...draft.toolCalls,
						...pending.map((call) => ({ id: call.id, atOffset: call.atOffset })),
					],
				}));
				const suspendedReply = yield* Ref.get(reply);
				return {
					kind: "suspended" as const,
					approvals: pending,
					checkpoint: {
						messages: [...segmentMessages, ...terminal.responseMessages],
						approvals: pending.map((request) => ({
							approvalId: request.approvalId,
							tool: request.tool,
							connectionId: request.connectionId,
							connectionRevision: request.connectionRevision,
							remoteToolName: request.remoteToolName,
						})),
						modelInput,
						reply: suspendedReply,
						accounting: addAccounting(prepared.checkpoint, accounting),
					},
				};
			});

			// Suspended so each check asks the store again rather than replaying one answer.
			const cancelChecks = Effect.suspend(() => store.isCancellationRequested(prepared)).pipe(
				Effect.repeat({
					schedule: Schedule.spaced(CANCELLATION_CHECK_INTERVAL),
					until: (requested) => requested,
				}),
			);
			const cancelWatch = Effect.raceFirst(cancelRequested(events, prepared), cancelChecks).pipe(
				Effect.andThen(Effect.fail(new TurnCancelled())),
			);
			const periodicSave = saveReply.pipe(
				Effect.repeat(Schedule.spaced(MESSAGE_FLUSH_INTERVAL)),
				Effect.andThen(Effect.never),
			);

			return yield* Effect.raceFirst(consume, Effect.raceFirst(cancelWatch, periodicSave)).pipe(
				Effect.timeoutOrElse({
					duration: TURN_TIMEOUT,
					orElse: () => Effect.fail(new TurnTimedOut()),
				}),
			);
		}),
	);

/** The built-in tools less the ones an admin switched off for this agent. */
function withoutDisabled(tools: ToolSet, disabled: readonly string[]): ToolSet {
	return Object.fromEntries(Object.entries(tools).filter(([key]) => !disabled.includes(key)));
}

/** Saves the reply so far, unless it is what was last saved. */
const saveReplySoFar = (
	prepared: PreparedTurn,
	store: TurnStore,
	reply: Ref.Ref<ReplyDraft>,
	lastSaved: Ref.Ref<ReplyDraft>,
): Effect.Effect<void, never, Database> =>
	Effect.gen(function* () {
		const draft = yield* Ref.get(reply);
		const saved = yield* Ref.get(lastSaved);
		if (
			draft.content === saved.content &&
			draft.collaborations.length === saved.collaborations.length &&
			draft.toolCalls.length === saved.toolCalls.length
		) {
			return;
		}
		yield* store.saveStreamingMessage(prepared, draft);
		yield* Ref.set(lastSaved, draft);
	});

/**
 * Appends each delta to the reply, publishing batched deltas to live
 * subscribers and saving when enough new text has arrived.
 */
const consumeDeltas = (
	prepared: PreparedTurn,
	text: AsyncIterable<string>,
	stop: AbortController,
	events: Pick<EventBus, "publish">,
	reply: Ref.Ref<ReplyDraft>,
	saveReply: Effect.Effect<void, never, Database>,
) =>
	Effect.gen(function* () {
		const initialLength = (yield* Ref.get(reply)).content.length;
		let pendingDelta = "";
		/** How much of the reply came before `pendingDelta`. */
		let pendingOffset = initialLength;
		let lastPublishedAt = 0;
		let savedLength = initialLength;

		const publishPending = Effect.suspend(() => {
			const delta = pendingDelta;
			const offset = pendingOffset;
			pendingDelta = "";
			pendingOffset += delta.length;
			return delta ? publishDelta(prepared, offset, delta, events) : Effect.void;
		});

		yield* forEachDelta(text, stop, (delta) =>
			Effect.gen(function* () {
				const { content } = yield* Ref.updateAndGet(reply, (draft) => ({
					...draft,
					content: draft.content + delta,
				}));
				pendingDelta += delta;
				const now = Date.now();
				if (now - lastPublishedAt >= Duration.toMillis(DELTA_PUBLISH_INTERVAL)) {
					lastPublishedAt = now;
					yield* publishPending;
				}
				if (content.length - savedLength >= MESSAGE_FLUSH_CHARACTERS) {
					savedLength = content.length;
					yield* saveReply;
				}
			}),
		);
		yield* publishPending;
	});

/** Waits for `turn.cancel_requested` on this turn. Never succeeds if the bus closes first. */
function cancelRequested(events: Pick<EventBus, "subscribe">, prepared: PreparedTurn) {
	return Effect.promise(async (signal) => {
		const channel = threadChannel(prepared.context.thread.id);
		for await (const { event } of events.subscribe(channel, { signal })) {
			if (event.type === "turn.cancel_requested" && event.turnId === prepared.turnId) return true;
		}
		return false;
	}).pipe(Effect.flatMap((requested) => (requested ? Effect.void : Effect.never)));
}

/** A delta a subscriber does not get is not worth failing the turn for. */
const publishDelta = (
	prepared: PreparedTurn,
	offset: number,
	text: string,
	events: Pick<EventBus, "publish">,
) =>
	Effect.promise(() =>
		events.publish(
			threadChannel(prepared.context.thread.id),
			streamEvent("message.delta", {
				threadId: prepared.context.thread.id,
				messageId: prepared.responseMessage.id,
				offset,
				text,
			}),
		),
	).pipe(
		Effect.catchCause((cause) =>
			Effect.sync(() => console.error("Publishing a message delta failed", cause)),
		),
	);

function addAccounting(
	checkpoint: TurnCheckpoint | undefined,
	segment: ModelAccounting,
): ModelAccounting {
	if (!checkpoint) return segment;
	const prior = checkpoint.accounting;
	const add = (left: number | undefined, right: number | undefined) =>
		left === undefined && right === undefined ? undefined : (left ?? 0) + (right ?? 0);
	return {
		usage: {
			modelCalls: add(prior.usage.modelCalls, segment.usage.modelCalls),
			inputTokens: add(prior.usage.inputTokens, segment.usage.inputTokens),
			outputTokens: add(prior.usage.outputTokens, segment.usage.outputTokens),
			totalTokens: add(prior.usage.totalTokens, segment.usage.totalTokens),
			reasoningTokens: add(prior.usage.reasoningTokens, segment.usage.reasoningTokens),
			cachedInputTokens: add(prior.usage.cachedInputTokens, segment.usage.cachedInputTokens),
		},
		reportedCost: add(prior.reportedCost, segment.reportedCost),
		contextTokens: segment.contextTokens,
		contextCapacity: segment.contextCapacity,
	};
}
