import { botForAskerForTests } from "@sugabots/core/authentication/testing";
import { TurnAuthentication } from "@sugabots/core/authentication/turn";
import { Turns } from "@sugabots/core/chats/turns/turns";
import { promising } from "@sugabots/core/database/testing";
import type { BotPrincipal } from "@sugabots/core/principal";
import { Lanes } from "@sugabots/core/workflows/lanes";
import { Cause, Clock, Duration, Effect, Layer, ManagedRuntime, Schema } from "effect";
import { DurableDeferred, type WorkflowEngine } from "effect/unstable/workflow";
import { beforeEach, describe, expect, it, onTestFinished, vi } from "vitest";
import * as Signals from "./signals.ts";
import { controlledClock, observedExecution } from "./testing.ts";
import {
	type Opening,
	type StepOutcome,
	type StepPlace,
	type StepResult,
	Turn,
	TurnActivities,
	turnWorkflow,
} from "./turn.workflow.ts";

/**
 * The turn workflow on its own, on the memory engine: the order of its
 * steps, when it authenticates, how it waits for approvals, retries and ends.
 * What each step does is a fake; the files beside this one run real steps on Postgres.
 */

type TurnRequest = Turns.TurnRequests.TurnRequest;

const opened = (turnId: string): Opening => ({ _tag: "Opened", turnId });
const finished: StepOutcome = { _tag: "Finished" };

const open = vi.fn((_turn: TurnRequest, _attempt: number) => Effect.succeed(opened("turn-1")));
const step = vi.fn(
	(_turn: TurnRequest, _principal: BotPrincipal, _place: StepPlace): Effect.Effect<StepResult> =>
		Effect.succeed(finished),
);
const cancelled = vi.fn((_principal: BotPrincipal, _turnId: string) => Effect.void);
const died = vi.fn(
	(
		_principal: BotPrincipal,
		_turnId: string,
		_cause: Cause.Cause<unknown>,
	): Effect.Effect<StepResult> => Effect.succeed(finished),
);
const unauthenticated = vi.fn((_turn: TurnRequest, _attempt: number) => Effect.void);
const abandon = vi.fn((_turn: TurnRequest) => Effect.void);
const announceReleased = vi.fn((_turn: TurnRequest) => Effect.void);
const release = vi.fn((_execution: { key: string; executionId: string }) => Effect.void);
const authenticate = vi.fn(
	(turnId: string): Effect.Effect<BotPrincipal, TurnAuthentication.TurnUnavailable> =>
		Effect.succeed(botForAskerForTests({ turn: turnId, chat: "chat", project: "project" })),
);

const admit = vi.fn<Lanes.Interface["admit"]>(() => Effect.succeed("started" as const));

const request = (): TurnRequest => ({
	chatId: crypto.randomUUID(),
	botId: crypto.randomUUID(),
	triggerMessageId: crypto.randomUUID(),
	reason: "mention",
});

/**
 * Starts the turn workflow for `asked` on a memory engine and a clock of its
 * own, until the case finishes, with the fakes standing in for its steps,
 * authentication and lanes. Returns its execution's id, the signals members'
 * decisions and interrupts reach it through, the clock, and what the case
 * waits for of it.
 */
async function started(asked: TurnRequest) {
	const executionId = await Effect.runPromise(Turn.executionId(asked));
	const execution = observedExecution(executionId);
	const time = await controlledClock();
	const runtime = ManagedRuntime.make(
		turnWorkflow.layer.pipe(
			Layer.provideMerge(
				Layer.succeed(
					TurnActivities,
					TurnActivities.of({
						open,
						step,
						release: () => Effect.void,
						cancelled,
						died,
						unauthenticated,
						abandon,
						announceReleased,
					}),
				),
			),
			Layer.provideMerge(
				Layer.succeed(TurnAuthentication.Service, TurnAuthentication.Service.of({ authenticate })),
			),
			Layer.provideMerge(
				Layer.succeed(
					Lanes.Service,
					Lanes.Service.of({
						admit,
						release,
						dropWaiting: () => Effect.die("unused"),
						reconcile: Effect.void,
					}),
				),
			),
			Layer.provideMerge(execution.engine),
			Layer.provideMerge(Layer.succeed(Clock.Clock, time.clock)),
		),
	);
	onTestFinished(() => runtime.dispose());
	const signals = await runtime.runPromise(Signals.make);
	await runtime.runPromise(Turn.execute(asked, { discard: true }));
	return {
		executionId,
		time,
		signals: promising<never>(runtime.runPromise)(signals),
		run: <A, E>(effect: Effect.Effect<A, E, WorkflowEngine.WorkflowEngine>) =>
			runtime.runPromise(effect),
		...execution,
	};
}

/** How long a turn waits after a failed step before running again, when its provider said nothing. */
const RETRY_DELAY = Duration.seconds(2);

/**
 * How long the turn's wait before running again was set for, in milliseconds:
 * the sleep waiting on its clock. A turn that runs again without one fails the case.
 */
const retryWait = (turn: Awaited<ReturnType<typeof started>>) =>
	Promise.race([
		turn.time.waiting(1),
		turn.completed().then(() => {
			throw new Error("Expected the turn to wait before running again, but it completed");
		}),
	]);

/** The places of the steps taken so far, in order. */
const placesTaken = () => step.mock.calls.map(([, , place]) => place);

describe("the turn workflow", () => {
	beforeEach(() => {
		for (const fake of [
			open,
			step,
			cancelled,
			died,
			unauthenticated,
			abandon,
			announceReleased,
			release,
			admit,
			authenticate,
		]) {
			fake.mockClear();
		}
	});

	it("reads the payload of a hand-back started before hand-backs had their name as a hand-back", () => {
		const json = Schema.toCodecJson(Turns.TurnRequests.TurnRequest);
		const payload = request();
		const stored = { ...payload, chatId: payload.chatId.toUpperCase(), reason: "resume" } as const;

		const decoded = Schema.decodeSync(json)(stored);

		expect(decoded.reason).toBe("hand_back");
		expect(Schema.encodeSync(json)(decoded)).toEqual({ ...payload, reason: "hand_back" });
	});

	it("opens the turn, authenticates its principal and takes a step at a time until it ends", async () => {
		step
			.mockReturnValueOnce(Effect.succeed({ _tag: "Continue" }))
			.mockReturnValueOnce(Effect.succeed({ _tag: "Continue" }));
		const asked = request();

		const turn = await started(asked);

		await turn.completed();
		expect(announceReleased).toHaveBeenCalledWith(asked);
		expect(open).toHaveBeenCalledWith(asked, 0);
		expect(authenticate).toHaveBeenCalledWith("turn-1");
		expect(placesTaken()).toEqual([
			{ turnId: "turn-1", attempt: 0, step: 0 },
			{ turnId: "turn-1", attempt: 0, step: 1 },
			{ turnId: "turn-1", attempt: 0, step: 2 },
		]);
		// Each step acts for the principal its execution authenticated.
		expect(step.mock.calls.map(([, principal]) => principal.turn)).toEqual([
			"turn-1",
			"turn-1",
			"turn-1",
		]);
	});

	it("authenticates the turn again each time it resumes, and takes the next step for the new principal", async () => {
		step.mockReturnValueOnce(Effect.succeed({ _tag: "Waiting", approvals: ["only"], taken: true }));
		const asked = request();
		const turn = await started(asked);
		await turn.suspended();
		expect(authenticate).toHaveBeenCalledTimes(1);

		await turn.signals.decide({
			executionId: turn.executionId,
			approvalId: "only",
			decision: { decision: "allow_once", memberId: "sam" },
		});

		await turn.completed();
		expect(announceReleased).toHaveBeenCalledWith(asked);
		// Resuming ran the workflow's own code again, and with it the authenticator;
		// the journaled step was not taken again.
		expect(authenticate).toHaveBeenCalledTimes(2);
		expect(placesTaken()).toEqual([
			{ turnId: "turn-1", attempt: 0, step: 0 },
			{ turnId: "turn-1", attempt: 0, step: 1 },
		]);
		const [, resumedFor] = step.mock.calls[1] ?? [];
		const [, firstFor] = step.mock.calls[0] ?? [];
		expect(resumedFor).not.toBe(firstFor);
	});

	it("ends an execution a newer one took over without journaling its step, which the next takes", async () => {
		step.mockReturnValueOnce(Effect.succeed({ _tag: "Superseded" }));
		const asked = request();
		const turn = await started(asked);
		await turn.suspended();
		expect(release).not.toHaveBeenCalled();

		await turn.run(Turn.resume(turn.executionId));

		await turn.completed();
		expect(announceReleased).toHaveBeenCalledWith(asked);
		// The step had no result, so the resumed execution took it, as its own principal.
		expect(placesTaken()).toEqual([
			{ turnId: "turn-1", attempt: 0, step: 0 },
			{ turnId: "turn-1", attempt: 0, step: 0 },
		]);
		expect(authenticate).toHaveBeenCalledTimes(2);
	});

	it("takes the same step again when it found the turn still waiting", async () => {
		step.mockReturnValueOnce(
			Effect.succeed({ _tag: "Waiting", approvals: ["only"], taken: false }),
		);
		const asked = request();
		const turn = await started(asked);
		await turn.suspended();

		await turn.signals.decide({
			executionId: turn.executionId,
			approvalId: "only",
			decision: { decision: "deny", memberId: "sam" },
		});

		await turn.completed();
		expect(announceReleased).toHaveBeenCalledWith(asked);
		expect(placesTaken()).toEqual([
			{ turnId: "turn-1", attempt: 0, step: 0 },
			{ turnId: "turn-1", attempt: 0, step: 0 },
		]);
	});

	it("ends a turn with nobody to act for without taking a step", async () => {
		authenticate.mockReturnValueOnce(
			Effect.fail(new TurnAuthentication.TurnUnavailable({ turn: "turn-1", reason: "noAsker" })),
		);
		const asked = request();

		const turn = await started(asked);

		await turn.completed();
		expect(announceReleased).toHaveBeenCalledWith(asked);
		expect(unauthenticated).toHaveBeenCalledWith(asked, 0);
		expect(step).not.toHaveBeenCalled();
	});

	it("opens a failed turn again once the retry delay has passed, and authenticates it again", async () => {
		step.mockReturnValueOnce(Effect.succeed({ _tag: "Retry" }));
		const asked = request();
		const turn = await started(asked);

		expect(await retryWait(turn)).toEqual([Duration.toMillis(RETRY_DELAY)]);
		expect(step).toHaveBeenCalledOnce();
		await turn.time.adjust(RETRY_DELAY);

		await turn.completed();
		expect(announceReleased).toHaveBeenCalledWith(asked);
		expect(open.mock.calls.map(([, attempt]) => attempt)).toEqual([0, 1]);
		expect(authenticate).toHaveBeenCalledTimes(2);
		expect(placesTaken()).toEqual([
			{ turnId: "turn-1", attempt: 0, step: 0 },
			{ turnId: "turn-1", attempt: 1, step: 0 },
		]);
		expect(abandon).not.toHaveBeenCalled();
	});

	it("waits as long as a rate-limited provider asked before running again", async () => {
		const askedToWait = Duration.seconds(30);
		step.mockReturnValueOnce(Effect.succeed({ _tag: "Retry", after: askedToWait }));
		const asked = request();
		const turn = await started(asked);
		expect(await retryWait(turn)).toEqual([Duration.toMillis(askedToWait)]);

		await turn.time.adjust(Duration.subtract(askedToWait, Duration.millis(1)));
		expect(step).toHaveBeenCalledOnce();
		await turn.time.adjust(Duration.millis(1));

		await turn.completed();
		expect(step).toHaveBeenCalledTimes(2);
		expect(announceReleased).toHaveBeenCalledWith(asked);
	});

	it("releases the lane when a turn is cancelled while waiting to retry", async () => {
		step.mockReturnValueOnce(Effect.succeed({ _tag: "Retry", after: Duration.seconds(30) }));
		const asked = request();
		const turn = await started(asked);
		expect(await retryWait(turn)).toEqual([Duration.toMillis(Duration.seconds(30))]);

		await turn.signals.cancel(turn.executionId);

		await turn.completed();
		expect(announceReleased).toHaveBeenCalledWith(asked);
		expect(open.mock.calls.map(([, attempt]) => attempt)).toEqual([0]);
	});

	it("releases the lane while waiting and reacquires after all approvals are decided", async () => {
		step.mockReturnValueOnce(
			Effect.succeed({ _tag: "Waiting", approvals: ["first", "second"], taken: true }),
		);
		admit.mockReturnValueOnce(Effect.succeed("waiting"));
		const asked = request();
		const turn = await started(asked);
		const { executionId } = turn;
		await turn.suspended();
		expect(release).toHaveBeenCalledOnce();
		expect(admit).not.toHaveBeenCalled();

		// The second approval is decided first; the first still waits.
		await turn.signals.decide({
			executionId,
			approvalId: "second",
			decision: { decision: "deny", memberId: "sam" },
		});
		await turn.suspended();
		expect(release).toHaveBeenCalledOnce();
		expect(admit).not.toHaveBeenCalled();

		await turn.signals.decide({
			executionId,
			approvalId: "first",
			decision: { decision: "allow_once", memberId: "alex" },
		});

		await turn.suspended();
		expect(admit).toHaveBeenCalledOnce();
		expect(step).toHaveBeenCalledOnce();
		const granted = Lanes.laneGranted("0/0/0");
		await turn.run(
			DurableDeferred.succeed(granted, {
				token: DurableDeferred.tokenFromExecutionId(granted, { workflow: Turn, executionId }),
				value: undefined,
			}),
		);
		await turn.completed();
		expect(announceReleased).toHaveBeenCalledWith(asked);
		expect(admit).toHaveBeenCalledExactlyOnceWith(
			expect.objectContaining({ whenBusy: "resume", payload: asked, resumeRound: "0/0/0" }),
		);
		expect(release).toHaveBeenCalledTimes(2);
		expect(step).toHaveBeenCalledTimes(2);
	});

	it("ends the turn when cancelled while queued for the lane after approval", async () => {
		step.mockReturnValueOnce(Effect.succeed({ _tag: "Waiting", approvals: ["only"], taken: true }));
		admit.mockReturnValueOnce(Effect.succeed("waiting"));
		const asked = request();
		const turn = await started(asked);
		await turn.suspended();
		await turn.signals.decide({
			executionId: turn.executionId,
			approvalId: "only",
			decision: { decision: "allow_once", memberId: "sam" },
		});
		await turn.suspended();
		expect(admit).toHaveBeenCalledOnce();

		await turn.signals.cancel(turn.executionId);

		await turn.completed();
		expect(cancelled).toHaveBeenCalledWith(expect.objectContaining({ turn: "turn-1" }), "turn-1");
		expect(step).toHaveBeenCalledTimes(1);
		expect(admit).toHaveBeenCalledTimes(1);
	});

	it("ends the turn when told it was cancelled while it waited", async () => {
		step.mockReturnValueOnce(Effect.succeed({ _tag: "Waiting", approvals: ["only"], taken: true }));
		const asked = request();
		const turn = await started(asked);
		await turn.suspended();

		await turn.signals.cancel(turn.executionId);

		await turn.completed();
		expect(release).toHaveBeenCalledWith({
			key: Turns.TurnRequests.turnLane(asked),
			executionId: turn.executionId,
		});
		expect(cancelled).toHaveBeenCalledWith(expect.objectContaining({ turn: "turn-1" }), "turn-1");
		expect(admit).not.toHaveBeenCalled();
		expect(step).toHaveBeenCalledTimes(1);
	});

	it("ends the turn as the execution whose step died, before freeing its lane", async () => {
		const order: string[] = [];
		const defect = new Error("database unavailable");
		step.mockReturnValueOnce(Effect.die(defect));
		died.mockImplementationOnce(() =>
			Effect.sync(() => {
				order.push("died");
				return finished;
			}),
		);
		release.mockImplementationOnce(() => Effect.sync(() => void order.push("release")));
		const asked = request();

		const turn = await started(asked);

		await turn.completed();
		expect(announceReleased).toHaveBeenCalledWith(asked);
		expect(died).toHaveBeenCalledWith(
			expect.objectContaining({ turn: "turn-1" }),
			"turn-1",
			expect.anything(),
		);
		const cause = died.mock.calls[0]?.[2];
		expect(cause && Cause.squash(cause)).toBe(defect);
		// Not by the workflow's id, which every execution of the turn shares.
		expect(abandon).not.toHaveBeenCalled();
		expect(order).toEqual(["died", "release"]);
	});

	it("leaves a turn whose step died to the newer execution that took it over", async () => {
		step.mockReturnValueOnce(Effect.die(new Error("database unavailable")));
		died.mockReturnValueOnce(Effect.succeed({ _tag: "Superseded" }));
		const asked = request();

		const turn = await started(asked);

		await turn.suspended();
		expect(release).not.toHaveBeenCalled();
		expect(abandon).not.toHaveBeenCalled();
	});
});
