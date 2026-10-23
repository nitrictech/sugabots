import { type Message, messageAuthorName, streamEvent, threadChannel } from "@sugabots/contracts";
import { type DomainError, userText } from "@sugabots/errors";
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
	type Scope,
	Semaphore,
} from "effect";
import { Artifacts } from "../../artifacts/artifacts.ts";
import { type Database, effectRunner, transaction } from "../../database/database.ts";
import { EventBus } from "../../database/events/bus.ts";
import { DeviceLinks } from "../../devices/device-links.ts";
import { Ids } from "../../ids/ids.ts";
import { A2A } from "../../providers/a2a/a2a.ts";
import { Models } from "../../providers/models/models.ts";
import type { UserFacing } from "../../user-message.ts";
import { AgentAdministration } from "../../workspaces/agents/agent-administration.ts";
import { ConversationEvents } from "../conversation-events.ts";
import { ConversationEvent } from "../events.ts";
import { BotRoutines } from "../routines/bot-routines.ts";
import { ThreadFiles } from "../thread-files/thread-files.ts";
import { messageTextWithPlacedParts } from "../threads/message-text.ts";
import { ARTIFACT_TOOLS } from "../tools/artifacts/tool.ts";
import { BuiltInTools } from "../tools/built-in.ts";
import { Collaborations } from "../tools/collaborate/collaborations.ts";
import { ConnectionTools } from "../tools/connections.ts";
import { SandboxTools } from "../tools/sandbox.ts";
import { SAVE_INSTRUCTIONS_TOOL } from "../tools/save-instructions/tool.ts";
import {
	callToolApproval,
	findApprovalTarget,
	toolCatalogNote,
} from "../tools/tool-search/tool.ts";
import { ApprovedToolCalls, type ToolApprovalsIncomplete } from "./approvals/approved-calls.ts";
import { modelPrompt, type TurnEnvironment } from "./context.ts";
import { type AsksFirst, deviceToolbox } from "./device-toolbox.ts";
import {
	type PreparedTurn,
	type RunsOn,
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
/** Above run_command's longest timeout, so a slow command leaves the turn time to answer. */
const TURN_TIMEOUT = Duration.minutes(30);
/** How many model calls a turn may make, across its segments. */
const TURN_MODEL_CALLS = 100;

/**
 * The services a segment runs on: the conversation services, the model, the
 * built-in and connection tools it offers, and the bus, which carries its
 * token deltas and which its tools watch.
 */
type SegmentServices =
	| Models.Service
	| A2A.Service
	| DeviceLinks.Service
	| BuiltInTools.Service
	| SandboxTools.Service
	| ConnectionTools.Service
	| EventBus.Service
	| TurnExecution.Service
	| TurnRepository.Service
	| ToolCallRepository.Service
	| Collaborations.Service
	| Artifacts.Authoring
	| ApprovedToolCalls.Service
	| AgentAdministration.Service
	| ThreadFiles.Service
	| BotRoutines.Service
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
	| Models.RequestFailure
	| ToolApprovalsIncomplete
	| TurnTimedOut
	| ApprovedToolChanged
	| TurnInterrupted
	| TurnStoppedUnexpectedly
	| ApprovalForUnknownTool
	| ReplyWithoutAnswer
	| A2A.RequestFailed
	| AgentOffline;

/** The bot stands for an agent on somebody's computer, which isn't connected or doesn't lend it. */
class AgentOffline extends Data.TaggedError("AgentOffline") implements UserFacing {
	override get message() {
		return "The device carrying this agent isn't connected or doesn't lend it";
	}
	get userMessage() {
		return userText`This bot is offline: the computer it runs on isn't connected. Try again once the Sugabots desktop app is running there.`;
	}
}

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
		return userText`The reply took too long and was stopped.`;
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
		return userText`A tool changed after it was approved, so it was not run.`;
	}
}
/** The process running the turn stopped before the reply finished. */
class TurnInterrupted extends Data.TaggedError("TurnInterrupted") implements UserFacing {
	override get message() {
		return "Turn interrupted by its process stopping";
	}
	get userMessage() {
		return userText`The reply was interrupted.`;
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
		return userText`The reply asked to run a tool it was not offered.`;
	}
}

/** The model finished without writing anything or asking anyone. */
class ReplyWithoutAnswer extends Data.TaggedError("ReplyWithoutAnswer") implements UserFacing {
	override get message() {
		return "Model finished without an answer";
	}
	get userMessage() {
		return userText`The reply stopped before answering.`;
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
			 * made. Nor does a model request that would fail the same way again,
			 * or that asks to be left longer than the turn should wait.
			 */
			const failed = (failure: TurnFailure) => {
				const request: DomainError | undefined = Models.isRequestFailure(failure)
					? failure
					: undefined;
				const waitsTooLong =
					request?.retryAfter !== undefined &&
					Duration.isGreaterThan(request.retryAfter, Models.MAX_RATE_LIMIT_WAIT);
				return logTurnFailure(prepared, failure.message).pipe(
					Effect.andThen(
						turns.fail(replyTurn, draft, {
							userMessage: failure.userMessage,
							mayRunAgain:
								!(failure instanceof ReplyWithoutAnswer) &&
								// Its computer coming back is for a person to notice, not a retry.
								!(failure instanceof AgentOffline) &&
								(request?.isRetryable ?? true) &&
								!waitsTooLong,
						}),
					),
					Effect.map(
						(willRetry): SegmentOutcome =>
							willRetry ? { _tag: "Retry", after: request?.retryAfter } : finished,
					),
				);
			};

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
		`(thread ${prepared.context.thread.id}, agent ${prepared.context.agent.name}, ${runsOnDescription(prepared.context.agent.runsOn)})`,
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
	| Models.RequestFailure
	| ToolApprovalsIncomplete
	| TurnTimedOut
	| ApprovedToolChanged
	| ApprovalForUnknownTool
	| ReplyWithoutAnswer
	| A2A.RequestFailed
	| AgentOffline
	| TurnCancelled,
	SegmentServices | Database
> =>
	Effect.scoped(
		Effect.gen(function* () {
			const events = yield* EventBus.Service;
			const turns = yield* TurnRepository.Service;

			// One writer at a time: the periodic save, the on-size save and a tool
			// marking the reply must not interleave, or an older draft could land
			// after a newer one.
			const oneWriter = yield* Semaphore.make(1);
			const lastSaved = yield* Ref.make<ReplyDraft>(emptyReply);
			const saveReply = oneWriter.withPermits(1)(
				saveReplySoFar(replyTurnOf(prepared), turns, reply, lastSaved),
			);

			const runsOn = prepared.context.agent.runsOn;
			const consume: Effect.Effect<
				StreamOutcome,
				Exclude<TurnFailure, TurnTimedOut | TurnInterrupted | TurnStoppedUnexpectedly>,
				SegmentServices | Database | Scope.Scope
			> = runsOn.kind === "a2a"
				? a2aReply(prepared, runsOn.endpoint, reply, saveReply)
				: modelReply(prepared, runsOn, reply, saveReply);

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

function runsOnDescription(runsOn: RunsOn) {
	return runsOn.kind === "model" ? `model ${runsOn.model}` : `A2A agent ${runsOn.endpoint.url}`;
}

/**
 * The reply from another service's agent, over A2A. It is sent what was said
 * since it last spoke, as one message naming each speaker, in the A2A
 * conversation that is this thread: it keeps its own history of the rest, and
 * runs its own tools. An agent lent from somebody's computer is also offered
 * ours, through the device, for as long as the turn runs.
 */
const a2aReply = (
	prepared: PreparedTurn,
	endpoint: A2A.Endpoint,
	reply: Ref.Ref<ReplyDraft>,
	saveReply: Effect.Effect<void, never, Database>,
) =>
	Effect.gen(function* () {
		const a2a = yield* A2A.Service;
		const events = yield* EventBus.Service;
		if (endpoint.deviceId !== null) {
			if (!(yield* DeviceLinks.Service).lends(endpoint.deviceId, endpoint.url)) {
				return yield* new AgentOffline();
			}
			const offered = yield* turnTools(prepared, {
				acceptsImages: false,
				reply,
				saveReply,
				signal: yield* Effect.abortSignal,
			});
			const kept = Object.fromEntries(
				Object.entries(offered.tools).filter(([key]) => !notForDeviceAgents(offered, key)),
			);
			yield* (yield* DeviceLinks.Service).offerTools(
				{
					deviceId: endpoint.deviceId,
					agentUrl: endpoint.url,
					contextId: prepared.context.thread.id,
				},
				yield* deviceToolbox({
					tools: kept,
					asksFirst: offered.asksFirst,
					callIdPrefix: prepared.turnId,
				}),
			);
		}
		const answer = yield* a2a.send({
			endpoint,
			contextId: prepared.context.thread.id,
			text: sinceLastSpoke(prepared.context.messages, prepared.context.agent.id),
		});
		yield* consumeDeltas(prepared, answer.text, events, reply, saveReply);
		yield* saveReply;
		yield* answer.finished;
		if ((yield* Ref.get(reply)).content.trim() === "") return yield* new ReplyWithoutAnswer();
		return { kind: "completed" as const, contextTokens: undefined };
	});

/**
 * Tools a lent agent isn't offered: the sandbox's, since it has its own
 * computer, and saving instructions, since it has no prompt of ours.
 */
function notForDeviceAgents(
	offered: { sandbox: { tools: object; requests: object } },
	key: string,
) {
	return (
		key in offered.sandbox.tools ||
		key in offered.sandbox.requests ||
		key === SAVE_INSTRUCTIONS_TOOL
	);
}

/** The thread's complete messages after `agentId`'s last, each with who said it. */
function sinceLastSpoke(messages: readonly Message[], agentId: string): string {
	const complete = messages.filter((message) => message.status === "complete");
	const lastSpoke = complete.findLastIndex(
		(message) => message.author.kind === "agent" && message.author.id === agentId,
	);
	return complete
		.slice(lastSpoke + 1)
		.map(
			(message) => `${messageAuthorName(message.author)}: ${messageTextWithPlacedParts(message)}`,
		)
		.join("\n\n");
}

/**
 * The tools a turn offers: the workspace's built-ins, the pod's sandbox and
 * connections, and Sugabots' own, each recorded as a tool call on the reply.
 * The connections' sessions close with the scope. A resumed segment's approved
 * calls must still name the tools they were approved for.
 */
const turnTools = (
	prepared: PreparedTurn,
	options: {
		acceptsImages: boolean;
		reply: Ref.Ref<ReplyDraft>;
		saveReply: Effect.Effect<void, never, Database>;
		signal: AbortSignal;
	},
) =>
	Effect.gen(function* () {
		const builtInTools = yield* BuiltInTools.Service;
		const connectionTools = yield* ConnectionTools.Service;
		const sandboxTools = yield* SandboxTools.Service;
		const turns = yield* TurnRepository.Service;
		const toolCalls = yield* ToolCallRepository.Service;
		const collaborations = yield* Collaborations.Service;
		const artifacts = yield* Artifacts.Authoring;
		const approvals = yield* ApprovedToolCalls.Service;
		const agents = yield* AgentAdministration.Service;
		const files = yield* ThreadFiles.Service;
		const routines = yield* BotRoutines.Service;
		const events = yield* EventBus.Service;

		// A tool runs inside the SDK as a promise, so it needs a way back to
		// this runtime's database.
		const context = yield* Effect.context<Database>();
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
			acceptsImages: options.acceptsImages,
			// A chat serves the files in its own thread, so only there can people be shown one.
			...(prepared.context.thread.type === "chat" && {
				attach: (file) => turns.attachFile(replyTurnOf(prepared), file),
			}),
		});
		// The connections' sessions live as long as the turn.
		const connections = yield* Effect.acquireRelease(
			connectionTools.forPod(prepared.context.thread.workspaceId, prepared.context.agent.podId, {
				turnId: prepared.turnId,
				agentId: prepared.context.agent.id,
				workspace: sandbox.usable ? sandbox.workspace : undefined,
				sandboxSignsIn: sandbox.signsIn,
			}),
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
		const asksFirst: AsksFirst = {
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
		const toolApproval: ToolApprovalConfiguration<ToolSet, unknown> = asksFirst;
		const { tools, catalog } = toolsForTurn(prepared, {
			collaborations,
			artifacts,
			calls: toolCalls,
			approvals,
			approvalBoundTools,
			builtIn,
			sandbox,
			connections: connections.tools,
			files,
			agents,
			routines,
			bus: events,
			run: effectRunner({ runPromiseExit: Effect.runPromiseExitWith(context) }),
			reply: {
				length: () => Ref.getUnsafe(options.reply).content.length,
				noteCollaboration: (collaboration) =>
					Ref.update(options.reply, (draft) => ({
						...draft,
						collaborations: [...draft.collaborations, collaboration],
					})).pipe(Effect.andThen(Effect.provideContext(options.saveReply, context))),
				noteToolCall: ({ id, atOffset }) =>
					Ref.update(options.reply, (draft) => ({
						...draft,
						toolCalls: draft.toolCalls.some((call) => call.id === id)
							? draft.toolCalls
							: [...draft.toolCalls, { id, atOffset }],
					})).pipe(Effect.andThen(Effect.provideContext(options.saveReply, context))),
				markActed: () =>
					Ref.update(options.reply, (draft) => ({ ...draft, acted: true })).pipe(
						Effect.andThen(Effect.provideContext(options.saveReply, context)),
					),
			},
			signal: options.signal,
		});
		return { builtIn, sandbox, connections, tools, catalog, toolApproval, asksFirst };
	});

/** The reply from one of the workspace's models, with the tools the turn offers it. */
const modelReply = (
	prepared: PreparedTurn,
	runsOn: Extract<RunsOn, { kind: "model" }>,
	reply: Ref.Ref<ReplyDraft>,
	saveReply: Effect.Effect<void, never, Database>,
) =>
	Effect.gen(function* () {
		const model = yield* Models.Service;
		const events = yield* EventBus.Service;
		const turns = yield* TurnRepository.Service;
		const approvals = yield* ApprovedToolCalls.Service;
		const files = yield* ThreadFiles.Service;
		const signal = yield* Effect.abortSignal;
		const now = yield* DateTime.nowAsDate;
		const { builtIn, sandbox, connections, tools, catalog, toolApproval } = yield* turnTools(
			prepared,
			{ acceptsImages: runsOn.acceptsImages, reply, saveReply, signal },
		);

		const environment: TurnEnvironment = {
			now,
			builtInTools: [
				...builtIn.usable,
				...Object.keys(tools).filter((key) => ARTIFACT_TOOLS.has(key)),
			],
			toolCatalog: toolCatalogNote({
				catalog,
				unavailable: connections.unavailable,
				instructions: connections.instructions,
			}),
			sandbox: sandbox.note,
		};
		const resultFiles = yield* files.resultFiles(prepared.context.thread.id);
		const freshPrompt = modelPrompt(prepared.context, environment, resultFiles);
		const modelInput =
			prepared.checkpoint?.modelInput ??
			({
				model: runsOn.model,
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
		const segmentMessages = approvalResponse ? [...priorMessages, approvalResponse] : priorMessages;
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

		yield* consumeDeltas(prepared, generated.text, events, reply, saveReply);
		yield* saveReply;
		const finished = yield* generated.finished;
		// A resumed segment starts with the earlier segment's tool results,
		// so the first segment's prompt is the one measured.
		const contextTokens = prepared.checkpoint?.contextTokens ?? finished.contextTokens;
		if (finished.approvalRequests.length === 0) {
			const { content, collaborations } = yield* Ref.get(reply);
			const answered = content.trim() !== "" || collaborations.length > 0;
			// Files the agent shared answer as words do. Looked up only when nothing else answered.
			const carriesFiles = Effect.map(
				turns.replyFiles(replyTurnOf(prepared)),
				(files) => files.length > 0,
			);
			if (!answered && !(yield* carriesFiles)) {
				return yield* new ReplyWithoutAnswer();
			}
			return { kind: "completed" as const, contextTokens };
		}
		const atOffset = (yield* Ref.get(reply)).content.length;
		const ids = yield* Ids.Service;
		const pending = yield* Effect.forEach(finished.approvalRequests, (request) => {
			const target = findApprovalTarget(connections.tools, request.toolCall);
			const asked:
				| Pick<ToolCallRepository.PendingToolApproval, "tool" | "input" | "binding" | "mutating">
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
