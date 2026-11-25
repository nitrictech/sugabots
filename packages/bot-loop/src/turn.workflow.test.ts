import { botForAskerForTests } from "@sugabots/core/authentication/testing";
import { TurnAuthentication } from "@sugabots/core/authentication/turn";
import { Turns } from "@sugabots/core/chats/turns/turns";
import type { BotPrincipal } from "@sugabots/core/principal";
import { Lanes } from "@sugabots/core/workflows/lanes";
import { Duration, Effect, Layer, ManagedRuntime, Option, Schema } from "effect";
import { TestClock } from "effect/testing";
import { DurableDeferred, WorkflowEngine } from "effect/unstable/workflow";
import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";
import * as Signals from "./signals.ts";
import {
	type Opening,
	type StepOutcome,
	type StepPlace,
	type StepResult,
	Turn,
	TurnSteps,
	turnWorkflow,
} from "./turn.workflow.ts";

/**
 * The turn workflow on its own, on the memory engine: the order of its
 * steps, when it authenticates, how it waits for approvals, retries and ends.
 * What each step does is a fake; `turn.test.ts` runs real steps on Postgres.
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
	(_principal: BotPrincipal, _turnId: string): Effect.Effect<StepResult> =>
		Effect.succeed(finished),
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

const runtime = ManagedRuntime.make(
	turnWorkflow.layer.pipe(
		Layer.provideMerge(
			Layer.succeed(
				TurnSteps,
				TurnSteps.of({
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
		Layer.provideMerge(WorkflowEngine.layerMemory),
		Layer.provideMerge(TestClock.layer()),
	),
);
const signals = await runtime.runPromise(Signals.make);

afterAll(() => runtime.dispose());

const request = (): TurnRequest => ({
	chatId: crypto.randomUUID(),
	botId: crypto.randomUUID(),
	triggerMessageId: crypto.randomUUID(),
	reason: "mention",
});

const untilSuspended = (executionId: string) =>
	vi.waitFor(async () => {
		const polled = await runtime.runPromise(Turn.poll(executionId));
		expect(Option.isSome(polled) && polled.value._tag).toBe("Suspended");
	});

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

		await runtime.runPromise(Turn.execute(asked, { discard: true }));

		await vi.waitFor(() => expect(announceReleased).toHaveBeenCalledWith(asked));
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
		const executionId = await runtime.runPromise(Turn.execute(asked, { discard: true }));
		await untilSuspended(executionId);
		expect(authenticate).toHaveBeenCalledTimes(1);

		await runtime.runPromise(
			signals.decide({
				executionId,
				approvalId: "only",
				decision: { decision: "allow_once", memberId: "sam" },
			}),
		);

		await vi.waitFor(() => expect(announceReleased).toHaveBeenCalledWith(asked));
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
		const executionId = await runtime.runPromise(Turn.execute(asked, { discard: true }));
		await untilSuspended(executionId);
		expect(release).not.toHaveBeenCalled();

		await runtime.runPromise(Turn.resume(executionId));

		await vi.waitFor(() => expect(announceReleased).toHaveBeenCalledWith(asked));
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
		const executionId = await runtime.runPromise(Turn.execute(asked, { discard: true }));
		await untilSuspended(executionId);

		await runtime.runPromise(
			signals.decide({
				executionId,
				approvalId: "only",
				decision: { decision: "deny", memberId: "sam" },
			}),
		);

		await vi.waitFor(() => expect(announceReleased).toHaveBeenCalledWith(asked));
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

		await runtime.runPromise(Turn.execute(asked, { discard: true }));

		await vi.waitFor(() => expect(announceReleased).toHaveBeenCalledWith(asked));
		expect(unauthenticated).toHaveBeenCalledWith(asked, 0);
		expect(step).not.toHaveBeenCalled();
	});

	it("opens a failed turn again once the retry delay has passed, and authenticates it again", async () => {
		step.mockReturnValueOnce(Effect.succeed({ _tag: "Retry" }));
		const asked = request();

		await runtime.runPromise(Turn.execute(asked, { discard: true }));
		await vi.waitFor(() => expect(step).toHaveBeenCalledTimes(1));

		await vi.waitFor(async () => {
			await runtime.runPromise(TestClock.adjust(Duration.seconds(2)));
			expect(step).toHaveBeenCalledTimes(2);
		});
		await vi.waitFor(() => expect(announceReleased).toHaveBeenCalledWith(asked));
		expect(open.mock.calls.map(([, attempt]) => attempt)).toEqual([0, 1]);
		expect(placesTaken()).toEqual([
			{ turnId: "turn-1", attempt: 0, step: 0 },
			{ turnId: "turn-1", attempt: 1, step: 0 },
		]);
		expect(abandon).not.toHaveBeenCalled();
	});

	it("waits as long as a rate-limited provider asked before running again", async () => {
		step.mockReturnValueOnce(Effect.succeed({ _tag: "Retry", after: Duration.seconds(30) }));
		const asked = request();
		await runtime.runPromise(Turn.execute(asked, { discard: true }));
		await vi.waitFor(() => expect(step).toHaveBeenCalledTimes(1));

		let waitedSeconds = 0;
		await vi.waitFor(
			async () => {
				await runtime.runPromise(TestClock.adjust(Duration.seconds(1)));
				waitedSeconds++;
				expect(step).toHaveBeenCalledTimes(2);
			},
			{ timeout: 5_000, interval: 1 },
		);
		expect(waitedSeconds).toBeGreaterThanOrEqual(30);
		await vi.waitFor(() => expect(announceReleased).toHaveBeenCalledWith(asked));
	});

	it("releases the lane when a turn is cancelled while waiting to retry", async () => {
		step.mockReturnValueOnce(Effect.succeed({ _tag: "Retry", after: Duration.seconds(30) }));
		const asked = request();
		const executionId = await runtime.runPromise(Turn.execute(asked, { discard: true }));
		await vi.waitFor(() => expect(step).toHaveBeenCalledOnce());

		await runtime.runPromise(signals.cancel(executionId));

		await vi.waitFor(() => expect(announceReleased).toHaveBeenCalledWith(asked));
		expect(open.mock.calls.map(([, attempt]) => attempt)).toEqual([0]);
	});

	it("releases the lane while waiting and reacquires after all approvals are decided", async () => {
		step.mockReturnValueOnce(
			Effect.succeed({ _tag: "Waiting", approvals: ["first", "second"], taken: true }),
		);
		admit.mockReturnValueOnce(Effect.succeed("waiting"));
		const asked = request();
		const executionId = await runtime.runPromise(Turn.execute(asked, { discard: true }));
		await untilSuspended(executionId);
		expect(release).toHaveBeenCalledOnce();
		expect(admit).not.toHaveBeenCalled();

		// The second approval is decided first; the first still waits.
		await runtime.runPromise(
			signals.decide({
				executionId,
				approvalId: "second",
				decision: { decision: "deny", memberId: "sam" },
			}),
		);
		await untilSuspended(executionId);
		expect(release).toHaveBeenCalledOnce();
		expect(admit).not.toHaveBeenCalled();

		await runtime.runPromise(
			signals.decide({
				executionId,
				approvalId: "first",
				decision: { decision: "allow_once", memberId: "alex" },
			}),
		);

		await vi.waitFor(() => expect(admit).toHaveBeenCalledOnce());
		await untilSuspended(executionId);
		expect(step).toHaveBeenCalledOnce();
		const granted = Lanes.laneGranted("0/0/0");
		await runtime.runPromise(
			DurableDeferred.succeed(granted, {
				token: DurableDeferred.tokenFromExecutionId(granted, { workflow: Turn, executionId }),
				value: undefined,
			}),
		);
		await vi.waitFor(() => expect(announceReleased).toHaveBeenCalledWith(asked));
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
		const executionId = await runtime.runPromise(Turn.execute(asked, { discard: true }));
		await untilSuspended(executionId);
		await runtime.runPromise(
			signals.decide({
				executionId,
				approvalId: "only",
				decision: { decision: "allow_once", memberId: "sam" },
			}),
		);
		await vi.waitFor(() => expect(admit).toHaveBeenCalledOnce());
		await untilSuspended(executionId);

		await runtime.runPromise(signals.cancel(executionId));

		await vi.waitFor(() =>
			expect(cancelled).toHaveBeenCalledWith(expect.objectContaining({ turn: "turn-1" }), "turn-1"),
		);
		expect(step).toHaveBeenCalledTimes(1);
		expect(admit).toHaveBeenCalledTimes(1);
	});

	it("ends the turn when told it was cancelled while it waited", async () => {
		step.mockReturnValueOnce(Effect.succeed({ _tag: "Waiting", approvals: ["only"], taken: true }));
		const asked = request();
		const executionId = await runtime.runPromise(Turn.execute(asked, { discard: true }));
		await untilSuspended(executionId);

		await runtime.runPromise(signals.cancel(executionId));

		await vi.waitFor(() =>
			expect(release).toHaveBeenCalledWith({
				key: Turns.TurnRequests.turnLane(asked),
				executionId,
			}),
		);
		await vi.waitFor(() =>
			expect(cancelled).toHaveBeenCalledWith(expect.objectContaining({ turn: "turn-1" }), "turn-1"),
		);
		expect(admit).not.toHaveBeenCalled();
		expect(step).toHaveBeenCalledTimes(1);
	});

	it("ends the turn as the execution whose step died, before freeing its lane", async () => {
		const order: string[] = [];
		step.mockReturnValueOnce(Effect.die(new Error("database unavailable")));
		died.mockImplementationOnce(() =>
			Effect.sync(() => {
				order.push("died");
				return finished;
			}),
		);
		release.mockImplementationOnce(() => Effect.sync(() => void order.push("release")));
		const asked = request();

		await runtime.runPromise(Turn.execute(asked, { discard: true }));

		await vi.waitFor(() => expect(announceReleased).toHaveBeenCalledWith(asked));
		expect(died).toHaveBeenCalledWith(expect.objectContaining({ turn: "turn-1" }), "turn-1");
		// Not by the workflow's id, which every execution of the turn shares.
		expect(abandon).not.toHaveBeenCalled();
		expect(order).toEqual(["died", "release"]);
	});

	it("leaves a turn whose step died to the newer execution that took it over", async () => {
		step.mockReturnValueOnce(Effect.die(new Error("database unavailable")));
		died.mockReturnValueOnce(Effect.succeed({ _tag: "Superseded" }));
		const asked = request();

		const executionId = await runtime.runPromise(Turn.execute(asked, { discard: true }));

		await untilSuspended(executionId);
		expect(release).not.toHaveBeenCalled();
		expect(abandon).not.toHaveBeenCalled();
	});
});
