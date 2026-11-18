import {
	type CollaborationPart,
	conversationStream,
	START_TASK_TOOL,
	streamEvent,
} from "@sugabots/contracts";
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
	Semaphore,
} from "effect";
import { type Database, effectRunner, transaction } from "../../database/database.ts";
import { EventBus } from "../../database/events/bus.ts";
import { ConversationFiles } from "../../files/conversation-files.ts";
import { Files } from "../../files/files.ts";
import { Ids } from "../../ids/ids.ts";
import { Installation } from "../../installation/installation.ts";
import { botConnectionsPath, searchSettingsPath } from "../../installation/web-app-paths.ts";
import { Models } from "../../providers/models/models.ts";
import type { UserFacing } from "../../user-message.ts";
import { BotAdministration } from "../../workspaces/bots/bot-administration.ts";
import { AssistantGuide } from "../assistant/assistant-guide.ts";
import { BotAutomations } from "../automations/bot-automations.ts";
import { BotTasks } from "../chats/bot-tasks.ts";
import { ConversationEvents } from "../conversation-events.ts";
import { ConversationEvent } from "../events.ts";
import { assistantRequests } from "../tools/assistant/tool.ts";
import { BuiltInTools } from "../tools/built-in.ts";
import { Collaborations } from "../tools/collaborate/collaborations.ts";
import { COLLABORATE_TOOL, collaborateTool } from "../tools/collaborate/tool.ts";
import { ComputerTools, type Request } from "../tools/computer.ts";
import { ConnectionTools, type OfferedTool } from "../tools/connections.ts";
import { FILE_TOOLS } from "../tools/files/tool.ts";
import { startTaskTool } from "../tools/start-task/tool.ts";
import {
	callToolApproval,
	findApprovalTarget,
	toolCatalogNote,
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
import { type SegmentOutcome, TurnSteps, turnOfStored } from "./turn.workflow.ts";

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
	| BuiltInTools.Service
	| ComputerTools.Service
	| ConnectionTools.Service
	| EventBus.Service
	| TurnExecution.Service
	| TurnRepository.Service
	| ToolCallRepository.Service
	| Collaborations.Service
	| Files.Authoring
	| ApprovedToolCalls.Service
	| BotAdministration.Service
	| ConversationFiles.Service
	| BotAutomations.Service
	| Installation.Service
	| BotTasks.Service
	| AssistantGuide.Service
	| Ids.Service;

/** The turn workflow's steps, which its activities reach through `TurnSteps`. */
export const turnStepsLayer = Layer.effect(
	TurnSteps,
	Effect.gen(function* () {
		const services = yield* Effect.context<SegmentServices | Database>();
		const turns = yield* TurnRepository.Service;
		const { emit } = yield* ConversationEvents.Service;
		return TurnSteps.of({
			segment: (stored) =>
				Effect.flatMap(turnRunFor(turnOfStored(stored)), runSegment).pipe(
					Effect.provideContext(services),
				),
			abandon: (stored) =>
				transaction(
					Effect.gen(function* () {
						const request = turnOfStored(stored);
						const run = yield* turnRunFor(request);
						const ended = yield* turns.abandon(run.executionId, {
							status: "failed",
							userMessage: TURN_STOPPED_UNEXPECTEDLY,
						});
						// Ending an active turn announced how it ended.
						if (ended) return;
						yield* emit([
							ConversationEvent.TurnAbandoned({
								conversationId: request.conversationId,
								botId: request.botId,
								outcome: { state: "failed", error: TURN_STOPPED_UNEXPECTEDLY },
							}),
						]);
					}),
				).pipe(Effect.provideContext(services)),
			cancelWaiting: (stored) => turns.cancelWaiting(turnOfStored(stored)),
			announceReleased: (stored) =>
				transaction(
					emit([
						ConversationEvent.LaneReleased({ conversationId: turnOfStored(stored).conversationId }),
					]),
				).pipe(Effect.provideContext(services)),
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
				// hears the turn completed, or the asking bot wakes to nothing
				// and gives up waiting for an answer that lands a moment later.
				yield* transaction(
					Effect.gen(function* () {
						// `answer` runs in a savepoint of this transaction, so a
						// defect in it rolls back only what it wrote, and catching it here
						// still lets the reply complete.
						if (prepared.context.conversation.parentConversationId) {
							yield* collaborations
								.answer({ conversationId: prepared.context.conversation.id, answer: draft.content })
								.pipe(
									Effect.catchCause((cause) =>
										Effect.logError("Delivering a collaboration answer failed", cause),
									),
								);
						}
						yield* turns.complete(replyTurn, draft, {
							contextTokens,
							contextCapacity: prepared.context.windowTokens,
							readKeptFrom: prepared.context.compaction?.keptFrom.toISOString() ?? null,
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
		`(conversation ${prepared.context.conversation.id}, bot ${prepared.context.bot.name}, model ${prepared.context.bot.model})`,
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
	| TurnCancelled,
	SegmentServices | Database
> =>
	Effect.scoped(
		Effect.gen(function* () {
			const model = yield* Models.Service;
			const events = yield* EventBus.Service;
			const builtInTools = yield* BuiltInTools.Service;
			const connectionTools = yield* ConnectionTools.Service;
			const computerTools = yield* ComputerTools.Service;
			const turns = yield* TurnRepository.Service;
			const toolCalls = yield* ToolCallRepository.Service;
			const collaborations = yield* Collaborations.Service;
			const authoring = yield* Files.Authoring;
			const approvals = yield* ApprovedToolCalls.Service;
			const bots = yield* BotAdministration.Service;
			const files = yield* ConversationFiles.Service;
			const automations = yield* BotAutomations.Service;
			const installation = yield* Installation.Service;
			const botTasks = yield* BotTasks.Service;
			const assistantGuide = yield* AssistantGuide.Service;
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
			const runInTurn = effectRunner({ runPromiseExit: Effect.runPromiseExitWith(context) });
			const now = yield* DateTime.nowAsDate;
			const offeredBuiltIns = yield* builtInTools.forWorkspace(
				prepared.context.conversation.workspaceId,
				`${installation.webAppUrl}${searchSettingsPath(prepared.context.workspaceSlug)}`,
			);
			const builtIn = {
				tools: offeredBuiltIns.tools,
				usable: offeredBuiltIns.usable.filter(
					(key) => !prepared.context.bot.disabledTools.includes(key),
				),
			};
			const computer = yield* computerTools.forTurn({
				workspaceId: prepared.context.conversation.workspaceId,
				usesComputer: prepared.context.bot.usesComputer,
				turnId: prepared.turnId,
				conversationId: prepared.context.conversation.id,
				botId: prepared.context.bot.id,
				color: prepared.context.bot.color,
				naturalBrowsing: prepared.context.bot.naturalBrowsing,
				acceptsImages: prepared.context.bot.acceptsImages,
				// A task or a channel's conversation serves the files in it, so only there can people be shown one.
				...((prepared.context.conversation.kind === "task" ||
					prepared.context.conversation.kind === "channel_conversation") && {
					attach: (file) => turns.attachFile(replyTurnOf(prepared), file),
				}),
			});
			// The connections' sessions live as long as the turn.
			const connections = yield* Effect.acquireRelease(
				connectionTools.forBot(prepared.context.conversation.workspaceId, prepared.context.bot.id, {
					turnId: prepared.turnId,
					botId: prepared.context.bot.id,
					conversationId: prepared.context.conversation.id,
					files,
					workspace: computer.usable ? computer.workspace : undefined,
					computerSignsIn: computer.signsIn,
				}),
				(opened) => Effect.promise(() => opened.close()),
			);
			const noteCollaboration = (collaboration: Pick<CollaborationPart, "id" | "atOffset">) =>
				Ref.update(reply, (draft) => ({
					...draft,
					collaborations: [...draft.collaborations, collaboration],
				})).pipe(Effect.andThen(Effect.provideContext(saveReply, context)));
			const { assistantOf } = prepared.context.bot;
			// A Personal Assistant asks its person before any call that may change
			// something, whatever its connections allow without asking.
			const offeredTools =
				assistantOf === null ? connections.tools : askingBeforeChanges(connections.tools);
			// A Personal Assistant knows and acts on its person's workspace only
			// while it answers them.
			const assistant =
				assistantOf !== null && prepared.context.askedBy === assistantOf
					? (() => {
							const person: AssistantGuide.Person = {
								userId: assistantOf,
								workspaceId: prepared.context.conversation.workspaceId,
								workspaceSlug: prepared.context.workspaceSlug,
							};
							const startsTasks: Request = {
								tool: startTaskTool({
									bot: {
										botId: prepared.context.bot.id,
										workspaceId: prepared.context.conversation.workspaceId,
										askedBy: assistantOf,
									},
									tasks: botTasks,
									run: runInTurn,
								}),
								refusal: () => undefined,
							};
							// The bot it asks acts with that bot's own connections and computer.
							const collaborates: Request = {
								tool: collaborateTool({
									from: {
										conversationId: prepared.context.conversation.id,
										botId: prepared.context.bot.id,
										turnId: prepared.turnId,
										messageId: prepared.responseMessage.id,
									},
									collaborations,
									bus: events,
									run: runInTurn,
									replyLength: () => Ref.getUnsafe(reply).content.length,
									noteCollaboration,
									signal,
								}),
								refusal: () => undefined,
							};
							// A task it starts, or a bot it asks, is seen by others, so it waits for its person too.
							const requests: Record<string, Request> = {
								...assistantRequests({ guide: assistantGuide, person, run: runInTurn }),
								[START_TASK_TOOL]: startsTasks,
								[COLLABORATE_TOOL]: collaborates,
							};
							return { guide: assistantGuide, person, requests };
						})()
					: undefined;
			// The built-in tools whose calls wait for a person to allow them.
			const builtInRequests = {
				...(computer.usable ? computer.requests : {}),
				...assistant?.requests,
			};
			const approvalBoundTools = new Set<string>();
			for (const binding of prepared.checkpoint?.approvals ?? []) {
				if ("builtIn" in binding) {
					if (!builtInRequests[binding.tool]) {
						return yield* new ApprovedToolChanged({ tool: binding.tool });
					}
					continue;
				}
				const offered = offeredTools[binding.tool];
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
				...callToolApproval(offeredTools),
				// A request refused outright runs at once, to be recorded as refused.
				...Object.fromEntries(
					Object.entries({ ...computer.requests, ...assistant?.requests }).map(([key, request]) => [
						key,
						(input: unknown) =>
							builtInRequests[key] && request.refusal(input) === undefined
								? "user-approval"
								: "not-applicable",
					]),
				),
			};
			const { tools, catalog } = toolsForTurn(prepared, {
				collaborations,
				authoring,
				calls: toolCalls,
				approvals,
				turns,
				approvalBoundTools,
				builtIn,
				computer,
				connections: offeredTools,
				files,
				bots,
				webAppUrl: installation.webAppUrl,
				automations,
				tasks: botTasks,
				bus: events,
				run: runInTurn,
				...(assistant && { assistant }),
				reply: {
					length: () => Ref.getUnsafe(reply).content.length,
					noteCollaboration,
					noteToolCall: ({ id, atOffset }) =>
						Ref.update(reply, (draft) => ({
							...draft,
							toolCalls: draft.toolCalls.some((call) => call.id === id)
								? draft.toolCalls
								: [...draft.toolCalls, { id, atOffset }],
						})).pipe(Effect.andThen(Effect.provideContext(saveReply, context))),
				},
				signal,
			});

			const environment: TurnEnvironment = {
				now,
				builtInTools: [
					...builtIn.usable,
					...Object.keys(tools).filter((key) => FILE_TOOLS.has(key)),
				],
				toolCatalog: toolCatalogNote({
					catalog,
					unavailable: connections.unavailable,
					signInExpired: connections.signInExpired,
					instructions: connections.instructions,
					addable: connections.addable,
					connectionsPageUrl: `${installation.webAppUrl}${botConnectionsPath(prepared.context.workspaceSlug, prepared.context.bot.handle)}`,
				}),
				computer: computer.note,
			};
			const resultFiles = yield* files.resultFiles(prepared.context.conversation.id);
			const freshPrompt = modelPrompt(prepared.context, environment, resultFiles);
			const modelInput =
				prepared.checkpoint?.modelInput ??
				({
					model: prepared.context.bot.model,
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
				workspaceId: prepared.context.conversation.workspaceId,
				activity: {
					purpose: "bot-turn",
					botId: prepared.context.bot.id,
					conversationId: prepared.context.conversation.id,
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
					const answered = content.trim() !== "" || collaborations.length > 0;
					// Files the bot shared answer as words do. Looked up only when nothing else answered.
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
					const target = findApprovalTarget(offeredTools, request.toolCall);
					const asked:
						| Pick<
								ToolCallRepository.PendingToolApproval,
								"tool" | "input" | "binding" | "mutating"
						  >
						| undefined = builtInRequests[request.toolCall.toolName]
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
		const stream = conversationStream(prepared.context.conversation.id);
		for await (const { event } of events.subscribe(stream, { signal })) {
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
			conversationStream(prepared.context.conversation.id),
			streamEvent("message.delta", {
				conversationId: prepared.context.conversation.id,
				messageId: prepared.responseMessage.id,
				offset,
				text,
			}),
		),
	).pipe(Effect.catchCause((cause) => Effect.logError("Publishing a message delta failed", cause)));

/**
 * `tools` with every one that may change something asking a person first,
 * whatever its connection allows, as a Personal Assistant's do.
 */
function askingBeforeChanges(
	tools: Readonly<Record<string, OfferedTool>>,
): Record<string, OfferedTool> {
	return Object.fromEntries(
		Object.entries(tools).map(([key, offered]) => [
			key,
			offered.mutating && offered.access === "allow" ? { ...offered, access: "ask" } : offered,
		]),
	);
}
