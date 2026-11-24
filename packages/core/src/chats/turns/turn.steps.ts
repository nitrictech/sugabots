import { chatStream, START_CHAT_TOOL, streamEvent } from "@sugabots/contracts";
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
import { ChatFileStore } from "../../files/chat-file-store.ts";
import { Files } from "../../files/files.ts";
import { Ids } from "../../ids/ids.ts";
import { Models } from "../../providers/models/models.ts";
import { ServerSettings } from "../../server-settings/server-settings.ts";
import { connectorsPagePath, searchSettingsPath } from "../../server-settings/web-app-paths.ts";
import type { UserFacing } from "../../user-message.ts";
import { BotAdministration } from "../../workspaces/bots/bot-administration.ts";
import { AssistantGuide } from "../assistant/assistant-guide.ts";
import { BotAutomations } from "../automations/bot-automations.ts";
import { ChatEvents } from "../chat-events.ts";
import { BotChats } from "../chats/bot-chats.ts";
import { ChatEvent } from "../events.ts";
import { assistantRequests } from "../tools/assistant/tool.ts";
import { BuiltInTools } from "../tools/built-in.ts";
import { ComputerTools, type Request } from "../tools/computer.ts";
import { ConnectorTools, type OfferedTool } from "../tools/connectors.ts";
import { FILE_TOOLS } from "../tools/files/tool.ts";
import { startChatTool } from "../tools/start-chat/tool.ts";
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
import { type ReplyDraft, type ReplyTurn, type TurnCheckpoint, TurnStore } from "./store.ts";
import { ToolCallStore } from "./tool-calls/store.ts";
import { bindingOf, toolsForTurn } from "./tools.ts";
import { type SegmentOutcome, TurnSteps } from "./turn.workflow.ts";

/** Token deltas are batched so a fast model does not publish per token. */
const DELTA_PUBLISH_INTERVAL = Duration.millis(50);
/** The reply so far is saved this often while it is written, so a crash loses little. */
const MESSAGE_FLUSH_INTERVAL = Duration.seconds(1);
/** ...and also whenever this much new text has arrived. */
const MESSAGE_FLUSH_CHARACTERS = 500;
/**
 * A running turn stops on `turn.interrupt_requested`. The flag is also read this
 * often, from the start, for a request made before the turn subscribed or
 * relayed from a process whose relay is down.
 */
const CANCELLATION_CHECK_INTERVAL = Duration.seconds(15);
/** Above run_command's longest timeout, so a slow command leaves the turn time to answer. */
const TURN_TIMEOUT = Duration.minutes(30);
/** How many model requests a turn may make, across its segments. */
const TURN_MODEL_REQUESTS = 100;

/**
 * The services a segment runs on: the chat services, the model, the
 * built-in and connector tools it offers, and the bus, which carries its
 * token deltas and which its tools watch.
 */
type SegmentServices =
	| Models.Service
	| BuiltInTools.Service
	| ComputerTools.Service
	| ConnectorTools.Service
	| EventBus.Service
	| TurnExecution.Service
	| TurnStore.Service
	| ToolCallStore.Service
	| Files.Authoring
	| ApprovedToolCalls.Service
	| BotAdministration.Service
	| ChatFileStore.Service
	| BotAutomations.Service
	| ServerSettings.Service
	| BotChats.Service
	| AssistantGuide.Service
	| Ids.Service;

/** The turn workflow's steps, which its activities reach through `TurnSteps`. */
export const turnStepsLayer = Layer.effect(
	TurnSteps,
	Effect.gen(function* () {
		const services = yield* Effect.context<SegmentServices | Database>();
		const turns = yield* TurnStore.Service;
		const { emit } = yield* ChatEvents.Service;
		return TurnSteps.of({
			segment: (stored) =>
				Effect.flatMap(turnRunFor(stored), runSegment).pipe(Effect.provideContext(services)),
			abandon: (stored) =>
				transaction(
					Effect.gen(function* () {
						const request = stored;
						const run = yield* turnRunFor(request);
						const ended = yield* turns.abandon(run.executionId, {
							status: "failed",
							userMessage: TURN_STOPPED_UNEXPECTEDLY,
						});
						// Ending an active turn announced how it ended.
						if (ended) return;
						yield* emit([
							ChatEvent.TurnAbandoned({
								chatId: request.chatId,
								botId: request.botId,
								triggerMessageId: request.triggerMessageId,
								reason: request.reason,
								outcome: { state: "failed", error: TURN_STOPPED_UNEXPECTEDLY },
							}),
						]);
					}),
				).pipe(Effect.provideContext(services)),
			cancelWaiting: (stored) => turns.cancelWaiting(stored),
			announceReleased: (stored) =>
				transaction(
					emit([
						ChatEvent.LaneReleased({
							chatId: stored.chatId,
							botId: stored.botId,
							triggerMessageId: stored.triggerMessageId,
							reason: stored.reason,
						}),
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

const emptyReply: ReplyDraft = { content: "", toolCalls: [] };

type StreamOutcome =
	| { kind: "completed"; contextTokens: number | undefined }
	/** On an optional turn, the bot wrote nothing: it chose not to answer. */
	| { kind: "silent"; contextTokens: number | undefined }
	| {
			kind: "suspended";
			checkpoint: TurnCheckpoint;
			approvals: ToolCallStore.PendingToolApproval[];
	  };

/** Why a reply stopped before the model finished, other than being cancelled. */
type TurnFailure =
	| Models.RequestFailure
	| ToolApprovalsIncomplete
	| TurnTimedOut
	| ApprovedToolChanged
	| TurnInterrupted
	| TurnStoppedUnexpectedly
	| ApprovalForUnknownTool
	| ReplyWithoutAnswer;

/** The turn was asked to stop, as when its automation run ended. */
class StopRequested extends Data.TaggedError("StopRequested") {
	override get message() {
		return "Turn asked to stop";
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
/** The model asked a member to approve a tool this turn does not offer for approval. */
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
 * The writing half may be interrupted: by its automation run ending, by the
 * time limit, or by the server shutting down. The recording half may not, or the
 * turn would be left `running` and the message `writing` forever. Hence the
 * mask: only the stream runs interruptibly, and whatever exit it produces is
 * written back before the fibre yields to the interrupt.
 */
const generateReply = (
	prepared: PreparedTurn,
): Effect.Effect<SegmentOutcome, never, SegmentServices | Database> =>
	Effect.uninterruptibleMask((restore) =>
		Effect.gen(function* () {
			const turns = yield* TurnStore.Service;
			const replyTurn = replyTurnOf(prepared);
			const reply = yield* Ref.make<ReplyDraft>(prepared.checkpoint?.reply ?? emptyReply);
			const streamed = yield* Effect.exit(restore(streamReply(prepared, reply)));
			const draft = yield* Ref.get(reply);

			/**
			 * Logs the failure and records what members are told of it; the turn
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
				const completion = {
					contextTokens,
					contextCapacity: prepared.context.windowTokens,
					readKeptFrom: prepared.context.compaction?.keptFrom.toISOString() ?? null,
				};
				if (streamed.value.kind === "silent") {
					yield* turns.staySilent(replyTurn, completion);
					return finished;
				}
				yield* turns.complete(replyTurn, draft, completion);
				return finished;
			}

			const cause = streamed.cause;
			if (Cause.hasInterruptsOnly(cause)) return yield* failed(new TurnInterrupted());
			const expected = Cause.findErrorOption(cause);
			if (Option.isNone(expected)) yield* Effect.logError("A turn's stream died", cause);
			const failure = Option.getOrElse(expected, () => new TurnStoppedUnexpectedly());
			if (failure instanceof StopRequested) {
				return yield* Effect.as(turns.cancel(replyTurn, draft), finished);
			}
			return yield* failed(failure);
		}),
	);

/** Enough in the server log to find the turn and the provider it used. */
const logTurnFailure = (prepared: PreparedTurn, why: string) =>
	Effect.logError(
		`Turn ${prepared.turnId} failed: ${why}`,
		`(chat ${prepared.context.chat.id}, bot ${prepared.context.bot.name}, model ${prepared.context.bot.model})`,
	);

/**
 * Streams the reply into `reply`, publishing deltas and saving the text so far
 * as it goes, until the model finishes or something stops it.
 *
 * Three things run alongside the stream and race it: a poll for the turn's
 * automation run ending, a periodic save of the reply so far, and the time limit.
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
	| StopRequested,
	SegmentServices | Database
> =>
	Effect.scoped(
		Effect.gen(function* () {
			const model = yield* Models.Service;
			const events = yield* EventBus.Service;
			const builtInTools = yield* BuiltInTools.Service;
			const connectorTools = yield* ConnectorTools.Service;
			const computerTools = yield* ComputerTools.Service;
			const turns = yield* TurnStore.Service;
			const toolCalls = yield* ToolCallStore.Service;
			const authoring = yield* Files.Authoring;
			const approvals = yield* ApprovedToolCalls.Service;
			const bots = yield* BotAdministration.Service;
			const files = yield* ChatFileStore.Service;
			const automations = yield* BotAutomations.Service;
			const serverSettings = yield* ServerSettings.Service;
			const botChats = yield* BotChats.Service;
			const assistantGuide = yield* AssistantGuide.Service;

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
				prepared.context.chat.workspaceId,
				`${serverSettings.webAppUrl}${searchSettingsPath(prepared.context.workspaceSlug)}`,
			);
			const builtIn = {
				tools: offeredBuiltIns.tools,
				usable: offeredBuiltIns.usable.filter(
					(key) => !prepared.context.bot.disabledTools.includes(key),
				),
			};
			const computer = yield* computerTools.forTurn({
				workspaceId: prepared.context.chat.workspaceId,
				projectId: prepared.context.projectId,
				usesComputer: prepared.context.bot.usesComputer,
				turnId: prepared.turnId,
				chatId: prepared.context.chat.id,
				botId: prepared.context.bot.id,
				color: prepared.context.bot.color,
				naturalBrowsing: prepared.context.bot.naturalBrowsing,
				acceptsImages: prepared.context.bot.acceptsImages,
				// A chat serves the files in it, so only there can members be shown one.
				...(prepared.context.chat.kind === "project_chat" && {
					attach: (file) => turns.attachFile(replyTurnOf(prepared), file),
				}),
			});
			// The connectors' sessions live as long as the turn.
			const connectors = yield* Effect.acquireRelease(
				connectorTools.forTurn(
					prepared.context.chat.workspaceId,
					{
						projectId: prepared.context.projectId,
						ownProjectId: prepared.context.bot.defaultProjectId,
					},
					{
						turnId: prepared.turnId,
						botId: prepared.context.bot.id,
						chatId: prepared.context.chat.id,
						files,
						computer: computer.usable ? computer.atPlace : undefined,
						computerSignsIn: computer.signsIn,
					},
				),
				(opened) => Effect.promise(() => opened.close()),
			);
			const { assistantOf } = prepared.context.bot;
			// A Personal Assistant asks its member before any call that may change
			// something, whatever its connectors allow without asking.
			const offeredTools =
				assistantOf === null ? connectors.tools : askingBeforeChanges(connectors.tools);
			// A Personal Assistant knows and acts on its member's workspace only
			// while it answers them.
			const assistant =
				assistantOf !== null && prepared.context.askerId === assistantOf
					? (() => {
							const member: AssistantGuide.Member = {
								memberId: assistantOf,
								workspaceId: prepared.context.chat.workspaceId,
								workspaceSlug: prepared.context.workspaceSlug,
							};
							const startsChats: Request = {
								tool: startChatTool({
									bot: {
										botId: prepared.context.bot.id,
										workspaceId: prepared.context.chat.workspaceId,
										askerId: assistantOf,
									},
									chats: botChats,
									run: runInTurn,
								}),
								refusal: () => undefined,
							};
							// A chat it starts is seen by others, so it waits for its member too.
							const requests: Record<string, Request> = {
								...assistantRequests({ guide: assistantGuide, member, run: runInTurn }),
								[START_CHAT_TOOL]: startsChats,
							};
							return { guide: assistantGuide, member, requests };
						})()
					: undefined;
			// The built-in tools whose calls wait for a member to allow them.
			const builtInRequests = {
				...(computer.usable ? computer.requests : {}),
				...assistant?.requests,
			};
			const approvalBoundTools = new Set<string>();
			for (const { tool, binding } of prepared.checkpoint?.approvals ?? []) {
				if (binding.kind === "built-in") {
					if (!builtInRequests[tool]) {
						return yield* new ApprovedToolChanged({ tool });
					}
					continue;
				}
				const offered = offeredTools[tool];
				if (
					!offered ||
					offered.connectorId !== binding.connectorId ||
					offered.connectorRevision !== binding.connectorRevision ||
					offered.remoteToolName !== binding.remoteToolName
				) {
					return yield* new ApprovedToolChanged({ tool });
				}
				approvalBoundTools.add(tool);
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
				authoring,
				calls: toolCalls,
				approvals,
				turns,
				approvalBoundTools,
				builtIn,
				computer,
				connectors: offeredTools,
				files,
				bots,
				webAppUrl: serverSettings.webAppUrl,
				automations,
				chats: botChats,
				run: runInTurn,
				...(assistant && { assistant }),
				reply: {
					length: () => Ref.getUnsafe(reply).content.length,
					noteToolCall: ({ id, atOffset }) =>
						Ref.update(reply, (draft) => ({
							...draft,
							toolCalls: draft.toolCalls.some((call) => call.id === id)
								? draft.toolCalls
								: [...draft.toolCalls, { id, atOffset }],
						})).pipe(Effect.andThen(Effect.provideContext(saveReply, context))),
				},
			});

			const { workspaceSlug, project: projectMembersMade } = prepared.context;
			const botConnectorsPageUrl = `${serverSettings.webAppUrl}${connectorsPagePath({ workspaceSlug, botHandle: prepared.context.bot.handle })}`;
			// The turn's connectors are its bot's default project's and, in a
			// project members made, that project's, which the chat is in.
			const connectorsPageUrlOf = (projectId: string) =>
				projectMembersMade && projectId !== prepared.context.bot.defaultProjectId
					? `${serverSettings.webAppUrl}${connectorsPagePath({ workspaceSlug, projectSlug: projectMembersMade.slug })}`
					: botConnectorsPageUrl;
			const environment: TurnEnvironment = {
				now,
				builtInTools: [
					...builtIn.usable,
					...Object.keys(tools).filter((key) => FILE_TOOLS.has(key)),
				],
				toolCatalog: toolCatalogNote({
					catalog,
					unavailable: connectors.unavailable,
					signInExpired: connectors.signInExpired.map(({ handle, projectId }) => ({
						handle,
						connectorsPageUrl: connectorsPageUrlOf(projectId),
					})),
					instructions: connectors.instructions,
					addable: connectors.addable,
					fromProjectAndBot: connectors.fromProjectAndBot,
					connectorsPageUrl: botConnectorsPageUrl,
				}),
				computer: computer.note,
			};
			const resultFiles = yield* files.resultFiles(prepared.context.chat.id);
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
				workspaceId: prepared.context.chat.workspaceId,
				purpose: {
					name: "bot-turn",
					botId: prepared.context.bot.id,
					chatId: prepared.context.chat.id,
					turnId: prepared.turnId,
				},
				model: modelInput.model,
				system: modelInput.system,
				messages: modelInput.messages,
				continuationMessages: segmentMessages,
				tools,
				toolApproval,
				maxSteps: Math.max(1, TURN_MODEL_REQUESTS - (prepared.checkpoint?.modelRequests ?? 0)),
			});

			const consume = Effect.gen(function* () {
				yield* consumeDeltas(prepared, generated.text, events, reply, saveReply);
				yield* saveReply;
				const finished = yield* generated.finished;
				// A resumed segment starts with the earlier segment's tool results,
				// so the first segment's prompt is the one measured.
				const contextTokens = prepared.checkpoint?.contextTokens ?? finished.contextTokens;
				if (finished.approvalRequests.length === 0) {
					const { content } = yield* Ref.get(reply);
					const answered = content.trim() !== "";
					// Files the bot shared answer as words do. Looked up only when nothing else answered.
					const carriesFiles = Effect.map(
						turns.replyFiles(replyTurnOf(prepared)),
						(files) => files.length > 0,
					);
					if (!answered && !(yield* carriesFiles)) {
						// Writing nothing is how a bot declines an optional turn.
						if (prepared.run.request.reason === "optional") {
							return { kind: "silent" as const, contextTokens };
						}
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
								ToolCallStore.PendingToolApproval,
								"tool" | "input" | "binding" | "writeOrDelete"
						  >
						| undefined = builtInRequests[request.toolCall.toolName]
						? {
								tool: request.toolCall.toolName,
								input: request.toolCall.input,
								binding: { kind: "built-in" },
								writeOrDelete: true,
							}
						: target
							? {
									tool: target.key,
									input: target.input,
									binding: bindingOf(target.offered),
									writeOrDelete: target.offered.writeOrDelete,
								}
							: undefined;
					if (!asked) {
						return Effect.fail(new ApprovalForUnknownTool({ tool: request.toolCall.toolName }));
					}
					return Effect.map(
						ids.next,
						(id): ToolCallStore.PendingToolApproval => ({
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
						approvals: pending.map(({ approvalId, tool, binding }) => ({
							approvalId,
							tool,
							binding,
						})),
						modelInput,
						reply: suspendedReply,
						modelRequests: (prepared.checkpoint?.modelRequests ?? 0) + finished.modelRequests,
						contextTokens,
					},
				};
			});

			// Suspended so each check reads the flag again rather than replaying one answer.
			const cancelChecks = Effect.suspend(() => turns.isInterruptRequested(prepared.turnId)).pipe(
				Effect.repeat({
					schedule: Schedule.spaced(CANCELLATION_CHECK_INTERVAL),
					until: (requested) => requested,
				}),
			);
			const cancelWatch = Effect.raceFirst(interruptRequested(events, prepared), cancelChecks).pipe(
				Effect.andThen(Effect.fail(new StopRequested())),
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
	turns: TurnStore.Interface,
	reply: Ref.Ref<ReplyDraft>,
	lastSaved: Ref.Ref<ReplyDraft>,
): Effect.Effect<void, never, Database> =>
	Effect.gen(function* () {
		const draft = yield* Ref.get(reply);
		const saved = yield* Ref.get(lastSaved);
		if (draft.content === saved.content && draft.toolCalls.length === saved.toolCalls.length) {
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

/** Waits for `turn.interrupt_requested` on this turn. Never succeeds if the bus closes first. */
function interruptRequested(events: Pick<EventBus.Interface, "subscribe">, prepared: PreparedTurn) {
	return Effect.promise(async (signal) => {
		const stream = chatStream(prepared.context.chat.id);
		for await (const { event } of events.subscribe(stream, { signal })) {
			if (event.type === "turn.interrupt_requested" && event.turnId === prepared.turnId)
				return true;
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
			chatStream(prepared.context.chat.id),
			streamEvent("message.delta", {
				chatId: prepared.context.chat.id,
				messageId: prepared.responseMessage.id,
				offset,
				text,
			}),
		),
	).pipe(Effect.catchCause((cause) => Effect.logError("Publishing a message delta failed", cause)));

/**
 * `tools` with every one that may change something asking a member first,
 * whatever its connector allows, as a Personal Assistant's do.
 */
function askingBeforeChanges(
	tools: Readonly<Record<string, OfferedTool>>,
): Record<string, OfferedTool> {
	return Object.fromEntries(
		Object.entries(tools).map(([key, offered]) => [
			key,
			offered.writeOrDelete && offered.access === "allow" ? { ...offered, access: "ask" } : offered,
		]),
	);
}
