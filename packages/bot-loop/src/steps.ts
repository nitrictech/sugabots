import { randomUUID } from "node:crypto";
import { chatStream } from "@sugabots/contracts";
import type { BotCannotReach, ResourceHidden, TurnEnded } from "@sugabots/contracts/errors/proofs";
import type { TurnExecutionSuperseded } from "@sugabots/contracts/errors/turns";
import type {
	ApprovalAsked,
	CallPlan,
	RequestedCall,
	StepCall,
	ToolResultOutput,
} from "@sugabots/contracts/turns";
import { Turns } from "@sugabots/core/chats/turns/turns";
import { EventBus } from "@sugabots/core/database/events/bus";
import type { Call } from "@sugabots/core/operations/operation";
import { Operations } from "@sugabots/core/operations/registry";
import type { BotPrincipal } from "@sugabots/core/principal";
import { processLayer } from "@sugabots/core/tiers";
import { type UserText, userText } from "@sugabots/errors";
import { DateTime, Duration, Effect, Exit, Layer, Option, Ref, Schedule } from "effect";
import {
	type StepOutcome,
	type StepPlace,
	type StepResult,
	Turn,
	TurnSteps,
} from "./turn.workflow.ts";

/**
 * A turn's steps, for its workflow: each one model request and the tool
 * calls it makes. Everything a step records goes through the loop's own
 * operations, called for the turn's principal; the tools it offers are its
 * bot's, built by core as they always have been.
 */

/** How many steps, so model requests, a turn may take in one run. */
export const TURN_STEPS = 100;
/** How a turn's steps are timed. */
export interface Timing {
	/** How long a step may take, its model request and its calls. */
	readonly stepTimeout: Duration.Duration;
	/**
	 * How often a step reads where its turn stands, from the start: whether it
	 * was asked to stop, ended, or was taken over by a newer execution. A stop
	 * is also heard as `turn.interrupt_requested`; this catches one asked for
	 * before the step listened or relayed from a process whose relay is down,
	 * and a takeover, which is heard of no other way.
	 */
	readonly checkEvery: Duration.Duration;
}

/**
 * How steps are timed in production: a step's timeout above run_command's
 * longest, so a slow command leaves the step time to answer.
 */
export const timing: Timing = {
	stepTimeout: Duration.minutes(30),
	checkEvery: Duration.seconds(15),
};

/** What members are told of a turn a defect ended, rather than a failure it expects. */
const TURN_STOPPED_UNEXPECTEDLY = userText`The reply stopped unexpectedly.`;
/** What members are told of a step that ran past its timeout. */
const STEP_TIMED_OUT = userText`The reply took too long and was stopped.`;
/** What members are told of a turn whose approved calls no longer match what was approved. */
const APPROVED_TOOL_CHANGED = userText`A tool changed after it was approved, so it was not run.`;
/** What members are told of a turn whose asker or bot no longer reaches its chat. */
const LOST_THE_CHAT = userText`This bot can no longer reach this chat, so it stopped.`;
/** What members are told of a turn that has nobody to act for. */
const NOBODY_TO_ACT_FOR = userText`This bot can't carry on here: the chat or the message it answers is gone`;

/**
 * The refusals the loop's own operations make when the principal no longer
 * runs the turn: it ended, a newer execution took it over, or the principal
 * lost its chat.
 */
type Refusal = TurnEnded | TurnExecutionSuperseded | ResourceHidden | BotCannotReach;

const finished: StepOutcome = { _tag: "Finished" };
const carryOn: StepOutcome = { _tag: "Continue" };

/** One of the loop's own calls, which no stored decision approves. */
const loopCall = (): Call => ({ kind: "request", request: randomUUID() });

/** The turn workflow's steps, which its activities reach through `TurnSteps`, timed as `timing` says. */
export const layerWith = ({ stepTimeout, checkEvery }: Timing) =>
	Layer.effect(
		TurnSteps,
		Effect.gen(function* () {
			const operations = yield* Operations.Service;
			const runs = yield* Turns.Runs.Service;
			const tools = yield* Turns.Tools.Service;
			const events = yield* EventBus.Service;

			const runOf = (request: Turns.TurnRequests.TurnRequest) =>
				Effect.map(Turn.executionId(request), (executionId) => ({ executionId, request }));

			/** Ends the turn whose principal no longer reaches its chat, as the principal may. */
			/**
			 * Ends the turn as failed, telling members `userMessage`, as its
			 * principal may whatever it still reaches; one a newer execution took
			 * over is left to that execution, and this one ends.
			 */
			const endLost = (principal: BotPrincipal, turnId: string, userMessage: UserText) =>
				operations["turns.endLost"](
					principal,
					{ turnId, ending: { _tag: "Failed", userMessage } },
					loopCall(),
				).pipe(
					Effect.as(finished),
					Effect.catch(
						(refusal): Effect.Effect<StepResult> =>
							Effect.succeed(
								refusal._tag === "TurnExecutionSuperseded" ? { _tag: "Superseded" } : finished,
							),
					),
				);

			/**
			 * What becomes of a step whose turn ended: a run this execution failed
			 * runs again, as its failure recorded, though the step that failed it
			 * is taken again after a restart; any other is over.
			 */
			const afterEnded = (principal: BotPrincipal, turnId: string) =>
				Effect.gen(function* (): Effect.fn.Return<StepResult> {
					const standing = yield* runs.standing(turnId);
					if (
						"executionNumber" in standing &&
						standing.executionNumber > principal.executionNumber
					) {
						return { _tag: "Superseded" };
					}
					if (
						standing._tag !== "Retrying" ||
						standing.executionNumber !== principal.executionNumber
					) {
						return finished;
					}
					if (standing.at === undefined) return { _tag: "Retry" };
					const now = yield* DateTime.nowAsDate;
					return {
						_tag: "Retry",
						after: Duration.millis(Math.max(0, standing.at.getTime() - now.getTime())),
					};
				});

			/**
			 * What becomes of a step the loop's own operations refused: one whose
			 * turn ended is over, or runs again as `afterEnded` says; one a newer execution took over ends this
			 * execution, recording nothing more; one whose principal lost the chat
			 * ends the turn through `EndsTurn`.
			 */
			const refused = (
				principal: BotPrincipal,
				turnId: string,
				refusal: Refusal,
			): Effect.Effect<StepResult> => {
				switch (refusal._tag) {
					case "TurnEnded":
						return afterEnded(principal, turnId);
					case "TurnExecutionSuperseded":
						return Effect.succeed({ _tag: "Superseded" });
					case "ResourceHidden":
					case "BotCannotReach":
						return endLost(principal, turnId, LOST_THE_CHAT);
				}
			};

			/** Records a failed run, and says whether the turn runs again. */
			const endFailed = (
				principal: BotPrincipal,
				turnId: string,
				failure: { userMessage: UserText; mayRunAgain: boolean; after?: Duration.Duration },
			) =>
				Effect.map(
					operations["turns.end"](
						principal,
						{
							chatId: principal.chat,
							turnId,
							ending: {
								kind: "failed",
								userMessage: failure.userMessage,
								mayRunAgain: failure.mayRunAgain,
								...(failure.after === undefined
									? {}
									: { retryAfterMillis: Duration.toMillis(failure.after) }),
							},
						},
						loopCall(),
					),
					({ willRetry }): StepOutcome =>
						willRetry ? { _tag: "Retry", after: failure.after } : finished,
				);

			/**
			 * Ends the turn as answered or cancelled. An answer a steer reached
			 * first, which no step has read, doesn't end it: the turn takes another
			 * step to read it, unless it may take no more (`noMoreSteps`), when the
			 * steer starts a turn of its own.
			 */
			const endAs = (
				principal: BotPrincipal,
				turnId: string,
				kind: "answered" | "cancelled",
				noMoreSteps = false,
			) =>
				Effect.map(
					operations["turns.end"](
						principal,
						{
							chatId: principal.chat,
							turnId,
							ending: kind === "answered" && noMoreSteps ? { kind, noMoreSteps } : { kind },
						},
						loopCall(),
					),
					({ steered }): StepOutcome => (steered ? carryOn : finished),
				);

			/** Takes one step: finishes what the last step left, then makes this one's model request. */
			const takeStep = (principal: BotPrincipal, place: StepPlace) =>
				Effect.gen(function* () {
					const { turnId, step } = place;
					const chatId = principal.chat;
					const loaded = yield* operations["turns.load"](
						principal,
						{ chatId, turnId, step },
						loopCall(),
					);
					if (loaded._tag === "Ended") return finished;
					if (loaded._tag === "Waiting") {
						return {
							_tag: "Waiting",
							approvals: loaded.approvals,
							taken: false,
						} satisfies StepOutcome;
					}
					return yield* Effect.scoped(
						Effect.gen(function* () {
							// A tool runs as a promise, so the first refusal its records meet is
							// kept here and given back as the step's, rather than as a throw.
							const stopped = yield* Ref.make(Option.none<Refusal>());
							const stopOn = <A>(recording: Effect.Effect<A, Refusal>) =>
								recording.pipe(
									Effect.catch((refusal) =>
										Ref.set(stopped, Option.some(refusal)).pipe(
											Effect.andThen(Effect.die(refusal)),
										),
									),
								);
							// The step whose calls are being made, which records them: this
							// one's, or the last one's when this step makes what it left.
							let recordingStep = step;
							const recordedCallIds = new Set(loaded.recordedCallIds);
							const approvedCallIds = new Set(loaded.approvals.map(({ toolCallId }) => toolCallId));
							const wasRecorded = (toolCallId: string) =>
								recordingStep === loaded.callsStep && recordedCallIds.has(toolCallId);
							const recordCall: Turns.Tools.ToolCallRecorder["open"] = (call) =>
								stopOn(
									operations["turns.recordToolCall"](
										principal,
										{ chatId, turnId, step: recordingStep, ...call },
										loopCall(),
									),
								);
							const recorder: Turns.Tools.ToolCallRecorder = {
								open: recordCall,
								close: (callId, outcome) =>
									stopOn(
										operations["turns.finishToolCall"](
											principal,
											{ chatId, turnId, callId, outcome },
											loopCall(),
										),
									),
								startApproved: ({ writeOrDelete, ...call }) =>
									wasRecorded(call.toolCallId) && !approvedCallIds.has(call.toolCallId)
										? recordCall({ ...call, writeOrDelete })
										: stopOn(
												Effect.map(
													operations["turns.startApprovedToolCall"](
														principal,
														{ chatId, turnId, ...call },
														loopCall(),
													),
													(started) => (started._tag === "Refused" ? undefined : started),
												),
											),
							};
							const offered = yield* tools.forStep(
								principal,
								operations,
								{
									turnId,
									executionNumber: principal.executionNumber,
									replyMessageId: loaded.replyMessageId,
									setting: loaded.setting,
									approvals: loaded.approvals,
								},
								recorder,
							);

							/** Makes one of the step's calls, and says what the model is given back. */
							const makeCall = (
								call: Pick<RequestedCall, "toolCallId" | "toolName" | "input" | "invalid">,
							) =>
								Effect.gen(function* () {
									if (call.invalid !== undefined) return errorOutput(call.invalid);
									const checked = yield* offered.checkInput(call);
									if ("invalid" in checked) return errorOutput(checked.invalid);
									const output = yield* Effect.tryPromise({
										try: (signal) => offered.execute({ ...call, input: checked.input }, signal),
										catch: (cause) => cause,
									}).pipe(
										Effect.catch((cause) =>
											Effect.flatMap(Ref.get(stopped), (refusal) =>
												Option.isSome(refusal) ? Effect.fail(refusal.value) : Effect.die(cause),
											),
										),
									);
									if (output instanceof Turns.Tools.ToolApprovalRequired) return output;
									return yield* offered.modelOutput({ ...call, input: checked.input, output });
								}).pipe(
									// A refusal its records met reaches here as a defect: give it back as one.
									Effect.catchDefect((defect) =>
										Effect.flatMap(Ref.get(stopped), (refusal) =>
											Option.isSome(refusal) ? Effect.fail(refusal.value) : Effect.die(defect),
										),
									),
									Effect.map((output) => ({ toolCallId: call.toolCallId, output })),
								);

							const recordResults = (
								results: ReadonlyArray<{ toolCallId: string; output: ToolResultOutput }>,
							) =>
								results.length === 0
									? Effect.void
									: operations["turns.recordToolResults"](
											principal,
											{ chatId, turnId, results },
											loopCall(),
										);

							/**
							 * Makes the calls of the step `callsStep` that have no result yet, as
							 * each one's plan says, and says what came of it: nothing more to
							 * do here, or how the step ended.
							 *
							 * Each call's plan is kept before any call is sent: sent at once, or
							 * first put to its approvers. A step taken again keeps to the plan,
							 * and puts a call to its approvers besides where it needs approval
							 * now, so a call that needed approval never runs without it. A call
							 * already put to its approvers runs once allowed.
							 */
							const finishCalls = (
								calls: readonly StepCall[],
								parked: typeof loaded.approvals,
								callsStep: number,
							) =>
								Effect.gen(function* (): Effect.fn.Return<StepOutcome | undefined, Refusal> {
									const unanswered = calls.filter((call) => call.result === undefined);
									if (unanswered.length === 0) return undefined;
									if (offered.changedApproval !== undefined) {
										return yield* endFailed(principal, turnId, {
											userMessage: APPROVED_TOOL_CHANGED,
											mayRunAgain: false,
										});
									}
									recordingStep = callsStep;
									const unplanned = unanswered.filter((call) => call.plan === undefined);
									const planned = new Map(
										yield* Effect.forEach(unplanned, (call) =>
											Effect.map(planFor(call), (plan) => [call.toolCallId, plan] as const),
										),
									);
									if (planned.size > 0) {
										yield* operations["turns.planToolCalls"](
											principal,
											{
												chatId,
												turnId,
												plans: [...planned].map(([toolCallId, plan]) => ({ toolCallId, plan })),
											},
											loopCall(),
										);
									}
									const parkedFor = new Map(
										parked.map((approval) => [approval.toolCallId, approval]),
									);
									const sends: StepCall[] = [];
									const denied: string[] = [];
									const withdrawn: string[] = [];
									const asks: Array<{ toolCallId: string; reopenCallId?: string } & ApprovalAsked> =
										[];
									for (const call of unanswered) {
										const approval = parkedFor.get(call.toolCallId);
										if (approval?.decision === "allowed") sends.push(call);
										else if (approval?.decision === "denied") denied.push(call.toolCallId);
										else if (approval?.decision === "withdrawn") withdrawn.push(call.toolCallId);
										else if (approval?.decision === "pending") {
											return { _tag: "Waiting", approvals: [approval.approvalId], taken: false };
										} else if (wasRecorded(call.toolCallId)) {
											sends.push(call);
										} else {
											const plan = call.plan ?? planned.get(call.toolCallId) ?? dispatch;
											// The stricter of the kept plan and what the call needs now.
											const now = yield* offered.approvalOf(call, plan._tag === "AskApproval");
											const asked =
												now === false
													? undefined
													: (now ?? (plan._tag === "AskApproval" ? plan.asked : undefined));
											if (asked) asks.push({ toolCallId: call.toolCallId, ...asked });
											else sends.push(call);
										}
									}
									const results = yield* Effect.forEach(sends, makeCall, {
										concurrency: "unbounded",
									});
									const completed = results.flatMap((result) => {
										if (!(result.output instanceof Turns.Tools.ToolApprovalRequired)) {
											return [{ toolCallId: result.toolCallId, output: result.output }];
										}
										asks.push({ toolCallId: result.toolCallId, ...result.output.asked });
										return [];
									});
									yield* recordResults([
										...completed,
										...denied.map((toolCallId) => ({ toolCallId, output: deniedOutput })),
										...withdrawn.map((toolCallId) => ({ toolCallId, output: withdrawnOutput })),
									]);
									if (asks.length === 0) return undefined;
									const waiting = yield* operations["turns.askForApprovals"](
										principal,
										{ chatId, turnId, step: callsStep, approvals: asks },
										loopCall(),
									);
									if (waiting._tag === "NotWaiting")
										return yield* endAs(principal, turnId, "cancelled");
									return {
										_tag: "Waiting",
										approvals: waiting.approvals,
										taken: callsStep === step,
									};
								});

							/** How a call is to be made now: put to its approvers if it waits for one, else sent. */
							const planFor = (call: StepCall) =>
								Effect.map(
									offered.approvalOf(call),
									(asked): CallPlan => (asked ? { _tag: "AskApproval", asked } : dispatch),
								);

							// The steps a turn may take: a step past them makes no request, unless
							// a steer reached the turn after its last, which gets one more to read
							// it. Past that one, a later steer starts a turn of its own.
							const noMoreSteps = step >= TURN_STEPS;
							if (step > TURN_STEPS || (noMoreSteps && !loaded.steered)) {
								return yield* endAs(principal, turnId, "answered", true);
							}
							// What the last step left: its calls that waited for approval, or that a
							// restart cut short, are made now, before this step's model request.
							const left = yield* finishCalls(loaded.calls, loaded.approvals, loaded.callsStep);
							if (left !== undefined) return left;
							if (loaded.requested) {
								return loaded.answered
									? yield* endAs(principal, turnId, "answered", noMoreSteps)
									: carryOn;
							}

							const lastStep = step >= TURN_STEPS - 1;
							const made = yield* operations["turns.makeModelRequest"](
								principal,
								{
									chatId,
									turnId,
									step,
									environment: offered.environment,
									tools: offered.offered,
									lastStep,
								},
								loopCall(),
							);
							// The last step was told it may not call tools: what it wrote is the answer.
							if (made._tag === "Answered") {
								return yield* endAs(principal, turnId, "answered", noMoreSteps);
							}
							if (made._tag === "Failed") {
								return yield* endFailed(principal, turnId, {
									userMessage: made.userMessage,
									mayRunAgain: made.mayRunAgain,
									...(made.retryAfterMillis === undefined
										? {}
										: { after: Duration.millis(made.retryAfterMillis) }),
								});
							}
							const ended = yield* finishCalls(made.calls, [], step);
							return ended ?? carryOn;
						}),
					);
				});

			/**
			 * Waits for the step to have to stop: the turn was asked to stop, as
			 * when its automation run ended; it ended; or a newer execution took it
			 * over, which this one is no longer. Stopping the step aborts the calls
			 * it is making.
			 */
			const mustStop = (chatId: string, turnId: string, execution: number) => {
				const heard = Effect.promise(async (signal) => {
					for await (const { event } of events.subscribe(chatStream(chatId), { signal })) {
						if (event.type === "turn.interrupt_requested" && event.turnId === turnId) return true;
					}
					return false;
				}).pipe(
					Effect.flatMap((requested) =>
						requested ? Effect.succeed("stopped" as const) : Effect.never,
					),
				);
				// Suspended so each check reads the turn again rather than replaying one answer.
				const read = Effect.suspend(() => runs.standing(turnId)).pipe(
					Effect.map((standing) => {
						if (standing._tag === "StopRequested") return "stopped" as const;
						if (standing._tag === "Ended" || standing._tag === "Retrying") return "ended" as const;
						return standing.executionNumber === execution ? undefined : ("superseded" as const);
					}),
					Effect.repeat({
						schedule: Schedule.spaced(checkEvery),
						until: (stop) => stop !== undefined,
					}),
					Effect.map((stop) => stop ?? ("stopped" as const)),
				);
				return Effect.raceFirst(heard, read);
			};

			return TurnSteps.of({
				open: (request, _attempt) =>
					Effect.gen(function* () {
						const opened = yield* runs.open(yield* runOf(request));
						return opened._tag === "Opened"
							? ({ _tag: "Opened", turnId: opened.turnId } as const)
							: ({ _tag: "NotRunnable" } as const);
					}),
				step: (_request, principal, place) => {
					const { turnId } = place;
					const stopped = mustStop(principal.chat, turnId, principal.executionNumber);
					return Effect.raceFirst(takeStep(principal, place), stopped).pipe(
						Effect.timeoutOrElse({
							duration: stepTimeout,
							orElse: () => Effect.succeed("timedOut" as const),
						}),
						Effect.flatMap((outcome): Effect.Effect<StepResult, Refusal> => {
							if (outcome === "stopped") return endAs(principal, turnId, "cancelled");
							if (outcome === "ended") return afterEnded(principal, turnId);
							if (outcome === "superseded") return Effect.succeed({ _tag: "Superseded" });
							if (outcome === "timedOut") {
								return endFailed(principal, turnId, {
									userMessage: STEP_TIMED_OUT,
									mayRunAgain: true,
								});
							}
							return Effect.succeed(outcome);
						}),
						Effect.catch((refusal) => refused(principal, turnId, refusal)),
						Effect.onExit((exit) =>
							Exit.isSuccess(exit) &&
							(exit.value._tag === "Continue" || exit.value._tag === "Waiting")
								? Effect.void
								: tools.release(principal),
						),
					);
				},
				release: tools.release,
				cancelled: (principal, turnId) =>
					operations["turns.endLost"](
						principal,
						{ turnId, ending: { _tag: "AsRequested" } },
						loopCall(),
					).pipe(Effect.ignore, Effect.ensuring(tools.release(principal))),
				died: (principal, turnId) => endLost(principal, turnId, TURN_STOPPED_UNEXPECTEDLY),
				unauthenticated: (request, _attempt) =>
					Effect.flatMap(runOf(request), (run) =>
						runs.abandon(run, { status: "failed", userMessage: NOBODY_TO_ACT_FOR }),
					),
				abandon: (request) =>
					Effect.flatMap(runOf(request), (run) =>
						runs.abandon(run, { status: "failed", userMessage: TURN_STOPPED_UNEXPECTEDLY }),
					),
				announceReleased: (request) => runs.announceReleased(request),
			});
		}),
	).pipe(processLayer);

/** The turn workflow's steps, timed as a server runs them. */
export const layer = layerWith(timing);

/** What the model is given back for a call that couldn't be made: why, as an error. */
function errorOutput(text: string): ToolResultOutput {
	return { type: "error-text", value: text } as ToolResultOutput;
}

/** A call sent at once. */
const dispatch: CallPlan = { _tag: "Dispatch" };

/**
 * What the model is given back for a call whose approval its asker withdrew by
 * writing again before anyone decided it: it was not made, and was not denied.
 */
const withdrawnOutput: ToolResultOutput = {
	type: "error-text",
	value:
		"Not run: your asker wrote again before anyone decided this, so its approval was withdrawn. Read their new message and do what it asks.",
} as ToolResultOutput;

/** What the model is given back for a call its approver denied. */
const deniedOutput: ToolResultOutput = {
	type: "execution-denied",
	reason: Turns.DENIED_OUTPUT.reason,
} as ToolResultOutput;
