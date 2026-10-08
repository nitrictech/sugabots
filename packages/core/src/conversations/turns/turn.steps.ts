import { streamEvent, threadChannel } from "@sugabots/contracts";
import type { ToolApprovalConfiguration, ToolSet } from "ai";
import {
	Cause,
	Clock,
	Data,
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
import { type Database, effectRunner, transaction } from "../../database/database.ts";
import { EventBus } from "../../database/events/bus.ts";
import { Ids } from "../../ids/ids.ts";
import { Models } from "../../providers/models/models.ts";
import { type UserFacing, UserMessage } from "../../user-message.ts";
import { AgentRepository } from "../../workspaces/agents/agent-repository.ts";
import { ConversationEvents } from "../conversation-events.ts";
import { ConversationEvent } from "../events.ts";
import { ThreadFiles } from "../thread-files/thread-files.ts";
import { BuiltInTools } from "../tools/built-in.ts";
import { Collaborations } from "../tools/collaborate/collaborations.ts";
import { ConnectionTools } from "../tools/connections.ts";
import { SandboxTools } from "../tools/sandbox.ts";
import {
	callToolApproval,
	connectionToolsNote,
	findApprovalTarget,
} from "../tools/tool-search/tool.ts";
import { ApprovedToolCalls, type ToolApprovalsIncomplete } from "./approvals/approved-calls.ts";
import { modelPrompt, type TurnEnvironment } from "./context.ts";
import {
	type PreparedTurn,
	replyTurnOf,
	TurnExecution,
	type TurnRun,
	turnRunFor,
} from "./execution.ts";
import { TURN_STOPPED_UNEXPECTEDLY } from "./lifecycle.ts";
import {
	type ReplyDraft,
	type ReplyTurn,
	type TurnCheckpoint,
	TurnRepository,
} from "./repository.ts";
import { ToolCallRepository } from "./tool-calls/repository.ts";
import { bindingOf, toolsForTurn } from "./tools.ts";
import { type SegmentOutcome, TurnSteps } from "./turn.workflow.ts";

/** Token deltas are batched so a fast model does not publish per token. */
const DELTA_PUBLISH_INTERVAL = Duration.millis(50);
/** The reply so far is saved this often while streaming, so a crash loses little. */
const MESSAGE_FLUSH_INTERVAL = Duration.seconds(1);
/** ...and also whenever this much new text has arrived. */
const MESSAGE_FLUSH_CHARACTERS = 500;
/**
 * A running turn stops on `turn.cancel_requested`. The flag is also read this
 * often, from the start, for a request made before the turn subscribed or
 * relayed from a process whose relay is down.
 */
const CANCELLATION_CHECK_INTERVAL = Duration.seconds(15);
const TURN_TIMEOUT = Duration.minutes(10);
/** How many model calls a turn may make, across its segments. */
const TURN_MODEL_CALLS = 20;

/**
 * The services a segment runs on: the conversation services, the model, the
 * built-in and connection tools it offers, and the bus, which carries its
 * token deltas and which its tools watch.
 */
type SegmentServices =
	| Models.Service
	| BuiltInTools.Service
	| SandboxTools.Service
	| ConnectionTools.Service
	| EventBus.Service
	| TurnExecution.Service
	| TurnRepository.Service
	| ToolCallRepository.Service
	| Collaborations.Service
	| ApprovedToolCalls.Service
	| AgentRepository.Service
	| ThreadFiles.Service
	| Ids.Service;

/** The turn workflow's steps, which its activities reach through `TurnSteps`. */
export const turnStepsLayer = Layer.effect(
	TurnSteps,
	Effect.gen(function* () {
		const services = yield* Effect.context<SegmentServices | Database>();
		const turns = yield* TurnRepository.Service;
		const { emit } = yield* ConversationEvents.Service;
		return TurnSteps.of({
			segment: (request) =>
				Effect.flatMap(turnRunFor(request), runSegment).pipe(Effect.provideContext(services)),
			abandon: (request) =>
				transaction(
					Effect.gen(function* () {
						const run = yield* turnRunFor(request);
						const ended = yield* turns.abandon(run.executionId, {
							status: "failed",
							userMessage: TURN_STOPPED_UNEXPECTEDLY,
						});
						// Ending an active turn announced how it ended.
						if (ended) return;
						yield* emit([
							ConversationEvent.TurnAbandoned({
								threadId: request.threadId,
								agentId: request.agentId,
								outcome: { state: "failed", error: TURN_STOPPED_UNEXPECTEDLY },
							}),
						]);
					}),
				).pipe(Effect.provideContext(services)),
			cancelWaiting: (request) => turns.cancelWaiting(request),
			announceReleased: (request) =>
				transaction(emit([ConversationEvent.LaneReleased({ threadId: request.threadId })])).pipe(
					Effect.provideContext(services),
				),
		});
	}),
);

/**
 * Runs one segment of a turn, from preparation to recorded outcome, and says
 * how it ended for the workflow.
 *
 * A turn that may not run ends before anything is streamed. Otherwise the
 * reply is streamed, and whatever ends the stream is written back as the
 * turn's outcome. A defect while preparing or recording escapes, and the
 * workflow then ends the turn as failed.
 */
export const runSegment = (
	run: TurnRun,
): Effect.Effect<SegmentOutcome, never, SegmentServices | Database> =>
	Effect.gen(function* () {
		const execution = yield* TurnExecution.Service;
		const preparation = yield* execution.prepare(run);
		return preparation._tag === "Prepared" ? yield* generateReply(preparation) : finished;
	});

const finished: SegmentOutcome = { _tag: "Finished" };
const retry: SegmentOutcome = { _tag: "Retry" };

const emptyReply: ReplyDraft = { content: "", collaborations: [], toolCalls: [] };

type StreamOutcome =
	| { kind: "completed"; contextTokens: number | undefined }
	| {
			kind: "suspended";
			checkpoint: TurnCheckpoint;
			approvals: ToolCallRepository.PendingToolApproval[];
	  };

/** Why a reply stopped streaming before the model finished, other than being cancelled. */
type TurnFailure =
	| Models.RequestFailed
	| ToolApprovalsIncomplete
	| TurnTimedOut
	| ApprovedToolChanged
	| TurnInterrupted
	| TurnStoppedUnexpectedly
	| ApprovalForUnknownTool
	| ReplyWithoutAnswer;

class TurnCancelled extends Data.TaggedError("TurnCancelled") {
	override get message() {
		return "Turn cancelled";
	}
}
class TurnTimedOut extends Data.TaggedError("TurnTimedOut") implements UserFacing {
	override get message() {
		return `Turn exceeded ${Duration.format(TURN_TIMEOUT)}`;
	}
	get userMessage() {
		return UserMessage.of`The reply took too long and was stopped.`;
	}
}
class ApprovedToolChanged
	extends Data.TaggedError("ApprovedToolChanged")<{ readonly tool: string }>
	implements UserFacing
{
	override get message() {
		return `Approved tool ${this.tool} no longer has the reviewed configuration`;
	}
	get userMessage() {
		return UserMessage.of`A tool changed after it was approved, so it was not run.`;
	}
}
/** The process running the turn stopped before the reply finished. */
class TurnInterrupted extends Data.TaggedError("TurnInterrupted") implements UserFacing {
	override get message() {
		return "Turn interrupted by its process stopping";
	}
	get userMessage() {
		return UserMessage.of`The reply was interrupted.`;
	}
}
/** A defect ended the turn rather than a failure it expects; the defect itself is logged. */
class TurnStoppedUnexpectedly
	extends Data.TaggedError("TurnStoppedUnexpectedly")
	implements UserFacing
{
	override get message() {
		return "Turn ended by a defect";
	}
	get userMessage() {
		return TURN_STOPPED_UNEXPECTEDLY;
	}
}
/** The model asked a person to approve a tool this turn does not offer for approval. */
class ApprovalForUnknownTool
	extends Data.TaggedError("ApprovalForUnknownTool")<{ readonly tool: string }>
	implements UserFacing
{
	override get message() {
		return `Approval requested for unknown tool ${this.tool}`;
	}
	get userMessage() {
		return UserMessage.of`The reply asked to run a tool it was not offered.`;
	}
}

/** The model finished without writing anything or asking anyone. */
class ReplyWithoutAnswer extends Data.TaggedError("ReplyWithoutAnswer") implements UserFacing {
	override get message() {
		return "Model finished without an answer";
	}
	get userMessage() {
		return UserMessage.of`The reply stopped before answering.`;
	}
}

/**
 * Streams the model's reply into the response message and records how it ended.
 *
 * The streaming half may be interrupted: by a person cancelling, by the time
 * limit, or by the server shutting down. The recording half may not, or the
 * turn would be left `running` and the message `streaming` forever. Hence the
 * mask: only the stream runs interruptibly, and whatever exit it produces is
 * written back before the fibre yields to the interrupt.
 */
const generateReply = (
	prepared: PreparedTurn,
): Effect.Effect<SegmentOutcome, never, SegmentServices | Database> =>
	Effect.uninterruptibleMask((restore) =>
		Effect.gen(function* () {
			const turns = yield* TurnRepository.Service;
			const collaborations = yield* Collaborations.Service;
			const replyTurn = replyTurnOf(prepared);
			const reply = yield* Ref.make<ReplyDraft>(prepared.checkpoint?.reply ?? emptyReply);
			const streamed = yield* Effect.exit(restore(streamReply(prepared, reply)));
			const draft = yield* Ref.get(reply);

			/**
			 * Logs the failure and records what people are told of it; the turn
			 * runs again only while that is safe and could help. A reply without
			 * an answer does not: running it again would repeat every tool call it
			 * made. Nor does a request the provider refused, which it would refuse again.
			 */
			const failed = (failure: TurnFailure) =>
				logTurnFailure(prepared, failure.message).pipe(
					Effect.andThen(
						turns.fail(replyTurn, draft, {
							userMessage: failure.userMessage,
							mayRunAgain:
								!(failure instanceof ReplyWithoutAnswer) &&
								!(failure instanceof Models.RequestFailed && !failure.mayRetry),
						}),
					),
					Effect.map((willRetry) => (willRetry ? retry : finished)),
				);

			if (Exit.isSuccess(streamed)) {
				if (streamed.value.kind === "suspended") {
					const { checkpoint, approvals } = streamed.value;
					return yield* transaction(
						Effect.gen(function* () {
							if (yield* turns.suspend(replyTurn, checkpoint, approvals)) {
								return {
									_tag: "Suspended",
									approvals: checkpoint.approvals.map((approval) => approval.approvalId),
								} satisfies SegmentOutcome;
							}
							yield* turns.cancel(replyTurn, draft);
							return finished;
						}),
					);
				}
				const { contextTokens } = streamed.value;
				// One transaction: the answer must be readable by the time anyone
				// hears the turn completed, or the asking agent wakes to nothing
				// and gives up waiting for an answer that lands a moment later.
				yield* transaction(
					Effect.gen(function* () {
						// `answer` runs in a savepoint of this transaction, so a
						// defect in it rolls back only what it wrote, and catching it here
						// still lets the reply complete.
						const answered = prepared.context.thread.parentThreadId
							? yield* collaborations
									.answer({ threadId: prepared.context.thread.id, answer: draft.content })
									.pipe(
										Effect.catchCause((cause) =>
											Effect.logError("Delivering a collaboration answer failed", cause).pipe(
												Effect.as(false),
											),
										),
									)
							: false;
						yield* turns.complete(replyTurn, draft, {
							contextTokens,
							contextCapacity: prepared.context.windowTokens,
							readKeptFrom: prepared.context.compaction?.keptFrom.toISOString() ?? null,
							answeredCollaboration: answered,
						});
					}),
				);
				return finished;
			}

			const cause = streamed.cause;
			if (Cause.hasInterruptsOnly(cause)) return yield* failed(new TurnInterrupted());
			const expected = Cause.findErrorOption(cause);
			if (Option.isNone(expected)) yield* Effect.logError("A turn's stream died", cause);
			const failure = Option.getOrElse(expected, () => new TurnStoppedUnexpectedly());
			if (failure instanceof TurnCancelled) {
				return yield* Effect.as(turns.cancel(replyTurn, draft), finished);
			}
			return yield* failed(failure);
		}),
	);

/** Enough in the server log to find the turn and the provider it used. */
const logTurnFailure = (prepared: PreparedTurn, why: string) =>
	Effect.logError(
		`Turn ${prepared.turnId} failed: ${why}`,
		`(thread ${prepared.context.thread.id}, agent ${prepared.context.agent.name}, model ${prepared.context.agent.model})`,
	);

/**
 * Streams the reply into `reply`, publishing deltas and saving the text so far
 * as it goes, until the model finishes or something stops it.
 *
 * Three things run alongside the stream and race it: a poll for a person
 * asking to cancel, a periodic save of the reply so far, and the time limit.
 * Whichever ends first, however it ends, interrupts the others, and closing
 * the scope aborts the model's request and the tools it is running.
 */
const streamReply = (
	prepared: PreparedTurn,
	reply: Ref.Ref<ReplyDraft>,
): Effect.Effect<
	StreamOutcome,
	| Models.RequestFailed
	| ToolApprovalsIncomplete
	| TurnTimedOut
	| ApprovedToolChanged
	| ApprovalForUnknownTool
	| ReplyWithoutAnswer
	| TurnCancelled,
	SegmentServices | Database
> =>
	Effect.scoped(
		Effect.gen(function* () {
			const model = yield* Models.Service;
			const events = yield* EventBus.Service;
			const builtInTools = yield* BuiltInTools.Service;
			const connectionTools = yield* ConnectionTools.Service;
			const sandboxTools = yield* SandboxTools.Service;
			const turns = yield* TurnRepository.Service;
			const toolCalls = yield* ToolCallRepository.Service;
			const collaborations = yield* Collaborations.Service;
			const approvals = yield* ApprovedToolCalls.Service;
			const agents = yield* AgentRepository.Service;
			const files = yield* ThreadFiles.Service;
			const signal = yield* Effect.abortSignal;

			// One writer at a time: the periodic save, the on-size save and a tool
			// marking the reply must not interleave, or an older draft could land
			// after a newer one.
			const oneWriter = yield* Semaphore.make(1);
			const lastSaved = yield* Ref.make<ReplyDraft>(emptyReply);
			const saveReply = oneWriter.withPermits(1)(
				saveReplySoFar(replyTurnOf(prepared), turns, reply, lastSaved),
			);

			// A tool runs inside the SDK as a promise, so it needs a way back to
			// this runtime's database.
			const context = yield* Effect.context<Database>();
			const now = yield* DateTime.nowAsDate;
			const offeredBuiltIns = yield* builtInTools.forWorkspace(prepared.context.thread.workspaceId);
			const builtIn = {
				tools: offeredBuiltIns.tools,
				usable: offeredBuiltIns.usable.filter(
					(key) => !prepared.context.agent.disabledTools.includes(key),
				),
			};
			const sandbox = yield* sandboxTools.forTurn({
				pod: {
					workspaceId: prepared.context.thread.workspaceId,
					podId: prepared.context.agent.podId,
				},
				usesSandbox: prepared.context.agent.usesSandbox,
				turnId: prepared.turnId,
				threadId: prepared.context.thread.id,
				agentId: prepared.context.agent.id,
				model: prepared.context.agent.model,
			});
			// The connections' sessions live as long as the turn.
			const connections = yield* Effect.acquireRelease(
				connectionTools.forPod(prepared.context.thread.workspaceId, prepared.context.agent.podId),
				(opened) => Effect.promise(() => opened.close()),
			);
			const approvalBoundTools = new Set<string>();
			for (const binding of prepared.checkpoint?.approvals ?? []) {
				if ("builtIn" in binding) {
					if (!sandbox.usable || !sandbox.requests[binding.tool]) {
						return yield* new ApprovedToolChanged({ tool: binding.tool });
					}
					continue;
				}
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
			const toolApproval: ToolApprovalConfiguration<ToolSet, unknown> = {
				...callToolApproval(connections.tools),
				// A request refused outright runs at once, to be recorded as refused.
				...Object.fromEntries(
					Object.entries(sandbox.requests).map(([key, request]) => [
						key,
						(input: unknown) =>
							sandbox.usable && request.refusal(input) === undefined
								? "user-approval"
								: "not-applicable",
					]),
				),
			};
			const tools = toolsForTurn(prepared, {
				collaborations,
				calls: toolCalls,
				approvals,
				approvalBoundTools,
				builtIn,
				sandbox,
				connections: connections.tools,
				files,
				agents,
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
				signal,
			});

			const environment: TurnEnvironment = {
				now,
				builtInTools: builtIn.usable,
				connectionTools: connectionToolsNote(connections),
				sandbox: sandbox.note,
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
				activity: {
					purpose: "agent-turn",
					podId: prepared.context.agent.podId,
					agentId: prepared.context.agent.id,
					threadId: prepared.context.thread.id,
					turnId: prepared.turnId,
				},
				model: modelInput.model,
				system: modelInput.system,
				messages: modelInput.messages,
				continuationMessages: segmentMessages,
				tools,
				toolApproval,
				maxSteps: Math.max(1, TURN_MODEL_CALLS - (prepared.checkpoint?.modelCalls ?? 0)),
			});

			const consume = Effect.gen(function* () {
				yield* consumeDeltas(prepared, generated.text, events, reply, saveReply);
				yield* saveReply;
				const finished = yield* generated.finished;
				// A resumed segment starts with the earlier segment's tool results,
				// so the first segment's prompt is the one measured.
				const contextTokens = prepared.checkpoint?.contextTokens ?? finished.contextTokens;
				if (finished.approvalRequests.length === 0) {
					const { content, collaborations } = yield* Ref.get(reply);
					if (content.trim() === "" && collaborations.length === 0) {
						return yield* new ReplyWithoutAnswer();
					}
					return { kind: "completed" as const, contextTokens };
				}
				const atOffset = (yield* Ref.get(reply)).content.length;
				const ids = yield* Ids.Service;
				const pending = yield* Effect.forEach(finished.approvalRequests, (request) => {
					const target = findApprovalTarget(connections.tools, request.toolCall);
					const asked:
						| Pick<
								ToolCallRepository.PendingToolApproval,
								"tool" | "input" | "binding" | "mutating"
						  >
						| undefined = sandbox.requests[request.toolCall.toolName]
						? {
								tool: request.toolCall.toolName,
								input: request.toolCall.input,
								binding: { kind: "built-in" },
								mutating: true,
							}
						: target
							? {
									tool: target.key,
									input: target.input,
									binding: bindingOf(target.offered),
									mutating: target.offered.mutating,
								}
							: undefined;
					if (!asked) {
						return Effect.fail(new ApprovalForUnknownTool({ tool: request.toolCall.toolName }));
					}
					return Effect.map(
						ids.next,
						(id): ToolCallRepository.PendingToolApproval => ({
							id,
							approvalId: request.approvalId,
							sdkToolCallId: request.toolCall.toolCallId,
							reason: request.reason,
							...asked,
							atOffset,
						}),
					);
				});
				// Only the checkpoint's reply places the calls: they exist once the
				// turn suspends, and a turn that may not suspend ends with the reply
				// as it was.
				const draft = yield* Ref.get(reply);
				const suspendedReply: ReplyDraft = {
					...draft,
					toolCalls: [
						...draft.toolCalls,
						...pending.map((call) => ({ id: call.id, atOffset: call.atOffset })),
					],
				};
				return {
					kind: "suspended" as const,
					approvals: pending,
					checkpoint: {
						messages: [...segmentMessages, ...finished.responseMessages],
						approvals: pending.map(({ approvalId, tool, binding }) =>
							binding.kind === "connection"
								? {
										approvalId,
										tool,
										connectionId: binding.connectionId,
										connectionRevision: binding.connectionRevision,
										remoteToolName: binding.remoteToolName,
									}
								: { approvalId, tool, builtIn: true as const },
						),
						modelInput,
						reply: suspendedReply,
						modelCalls: (prepared.checkpoint?.modelCalls ?? 0) + finished.modelCalls,
						contextTokens,
					},
				};
			});

			// Suspended so each check reads the flag again rather than replaying one answer.
			const cancelChecks = Effect.suspend(() =>
				turns.isCancellationRequested(prepared.turnId),
			).pipe(
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

/** Saves the reply so far, unless it is what was last saved. */
const saveReplySoFar = (
	replyTurn: ReplyTurn,
	turns: TurnRepository.Interface,
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
		yield* turns.saveReply(replyTurn, draft);
		yield* Ref.set(lastSaved, draft);
	});

/**
 * Appends each delta to the reply, publishing batched deltas to live
 * subscribers and saving when enough new text has arrived.
 */
const consumeDeltas = (
	prepared: PreparedTurn,
	text: AsyncIterable<string>,
	events: Pick<EventBus.Interface, "publish">,
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

		yield* Models.forEachDelta(text, (delta) =>
			Effect.gen(function* () {
				const { content } = yield* Ref.updateAndGet(reply, (draft) => ({
					...draft,
					content: draft.content + delta,
				}));
				pendingDelta += delta;
				const now = yield* Clock.currentTimeMillis;
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
function cancelRequested(events: Pick<EventBus.Interface, "subscribe">, prepared: PreparedTurn) {
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
	events: Pick<EventBus.Interface, "publish">,
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
	).pipe(Effect.catchCause((cause) => Effect.logError("Publishing a message delta failed", cause)));
