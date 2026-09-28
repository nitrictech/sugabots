import { describe, expect, it } from "vitest";
import { UserMessage } from "../../user-message.ts";
import {
	FollowUp,
	MAX_TURN_RUNS,
	ROUTINE_EXECUTION_ENDED,
	runsAgainAfterFailure,
	TURN_CANCELLED,
	TurnEvent,
	type TurnState,
	transition,
} from "./lifecycle.ts";

/**
 * A turn's lifecycle on its own: what each event makes of a turn, and which
 * ones it refuses.
 */

const owner = "workflow-execution-1";
const providerDown = UserMessage.of`The model provider could not answer.`;

const facts = {
	owner,
	cancelRequested: false,
	runs: 1,
	checkpointed: false,
	mutationStarted: false,
};

function turn(
	overrides: Partial<typeof facts> & { status?: "running" | "waiting" | "done" | "cancelled" } = {},
): TurnState {
	return { status: "running", ...facts, ...overrides };
}

function failedTurn(overrides: Partial<typeof facts> = {}): TurnState {
	return { status: "failed", userMessage: providerDown, ...facts, ...overrides };
}

const reopen = (state: TurnState, uncertainMutation = false) =>
	transition(state, TurnEvent.Reopen({ owner, uncertainMutation }));

describe("reopening a turn for another run", () => {
	it("starts the reply again for a turn that failed", () => {
		expect(reopen(failedTurn())).toEqual({
			_tag: "Next",
			state: turn({ runs: 2 }),
			followUp: FollowUp.Restart(),
		});
	});

	it("resumes a suspended turn from its checkpoint for the workflow that owns it", () => {
		expect(reopen(turn({ status: "waiting", checkpointed: true, runs: 0 }))).toEqual({
			_tag: "Next",
			state: turn({ checkpointed: true, runs: 1 }),
			followUp: FollowUp.Resume(),
		});
	});

	it("refuses to resume a suspended turn for another workflow", () => {
		expect(
			reopen(turn({ status: "waiting", checkpointed: true, owner: "another-execution" })),
		).toMatchObject({ _tag: "Refused" });
	});

	it("refuses a turn that is done or cancelled", () => {
		expect(reopen(turn({ status: "done" }))).toMatchObject({ _tag: "Refused" });
		expect(reopen(turn({ status: "cancelled" }))).toMatchObject({ _tag: "Refused" });
	});

	it("ends as cancelled a turn somebody asked to stop", () => {
		expect(reopen(turn({ cancelRequested: true }))).toEqual({
			_tag: "Next",
			state: turn({ status: "cancelled", cancelRequested: true }),
			followUp: FollowUp.End({ userMessage: TURN_CANCELLED }),
		});
	});

	// ADR 002: running it again could make the change a second time.
	it("ends as failed a turn whose mutating tool may have run without a checkpoint", () => {
		expect(reopen(turn({ mutationStarted: true }))).toMatchObject({
			_tag: "Next",
			state: { status: "failed", userMessage: expect.stringContaining("mutating tool") },
			followUp: { _tag: "End" },
		});
	});

	it("ends as failed a checkpointed turn whose mutating call was left running", () => {
		const state = turn({ status: "waiting", checkpointed: true, mutationStarted: true });
		expect(reopen(state, true)).toMatchObject({ _tag: "Next", state: { status: "failed" } });
		expect(reopen(state, false)).toMatchObject({ _tag: "Next", followUp: FollowUp.Resume() });
	});

	it("gives up on a turn that has stopped as many times as it may run", () => {
		expect(reopen(turn({ runs: MAX_TURN_RUNS }))).toMatchObject({
			_tag: "Next",
			state: {
				status: "failed",
				userMessage: `The turn stopped ${MAX_TURN_RUNS} times before it could finish`,
			},
		});
		expect(reopen(turn({ runs: MAX_TURN_RUNS - 1 }))).toMatchObject({
			followUp: FollowUp.Restart(),
		});
	});
});

describe("suspending for approvals", () => {
	it("parks a running turn and starts its run count again", () => {
		expect(transition(turn({ runs: 2 }), TurnEvent.Suspend())).toEqual({
			_tag: "Next",
			state: turn({ status: "waiting", checkpointed: true, runs: 0 }),
		});
	});

	it("refuses a turn somebody asked to stop, or one no longer running", () => {
		expect(transition(turn({ cancelRequested: true }), TurnEvent.Suspend())._tag).toBe("Refused");
		expect(transition(failedTurn(), TurnEvent.Suspend())._tag).toBe("Refused");
	});
});

describe("ending a run", () => {
	it("completes, fails or cancels a running turn, dropping its checkpoint", () => {
		const running = turn({ checkpointed: true });
		expect(transition(running, TurnEvent.Complete())).toEqual({
			_tag: "Next",
			state: turn({ status: "done" }),
		});
		expect(transition(running, TurnEvent.Fail({ userMessage: providerDown }))).toEqual({
			_tag: "Next",
			state: failedTurn(),
		});
		expect(transition(running, TurnEvent.Cancel())).toEqual({
			_tag: "Next",
			state: turn({ status: "cancelled" }),
		});
	});

	it("does not end a turn that has already ended", () => {
		expect(transition(turn({ status: "cancelled" }), TurnEvent.Complete())._tag).toBe("Refused");
		expect(
			transition(turn({ status: "done" }), TurnEvent.Fail({ userMessage: providerDown }))._tag,
		).toBe("Refused");
	});

	it("abandons an active turn, ending its reply and calls", () => {
		const stopped = UserMessage.of`The reply stopped unexpectedly.`;
		expect(
			transition(
				turn({ status: "waiting" }),
				TurnEvent.Abandon({ status: "failed", userMessage: stopped }),
			),
		).toEqual({
			_tag: "Next",
			state: { ...failedTurn(), userMessage: stopped },
			followUp: FollowUp.End({ userMessage: stopped }),
		});
		expect(
			transition(turn(), TurnEvent.Abandon({ status: "cancelled", userMessage: TURN_CANCELLED })),
		).toEqual({
			_tag: "Next",
			state: turn({ status: "cancelled" }),
			followUp: FollowUp.End({ userMessage: TURN_CANCELLED }),
		});
	});
});

describe("cancelling", () => {
	it("tells a waiting turn's workflow, which records the cancellation", () => {
		expect(transition(turn({ status: "waiting" }), TurnEvent.RequestCancel())).toEqual({
			_tag: "Next",
			state: turn({ status: "waiting", cancelRequested: true }),
			followUp: FollowUp.SignalOwner({ owner }),
		});
	});

	it("asks a running turn's worker to stop, once", () => {
		expect(transition(turn(), TurnEvent.RequestCancel())).toEqual({
			_tag: "Next",
			state: turn({ cancelRequested: true }),
			followUp: FollowUp.AnnounceCancelRequest(),
		});
		expect(transition(turn({ cancelRequested: true }), TurnEvent.RequestCancel())._tag).toBe(
			"Refused",
		);
	});

	it("records a waiting turn as cancelled when its workflow stops waiting", () => {
		expect(
			transition(turn({ status: "waiting", checkpointed: true }), TurnEvent.CancelWaiting()),
		).toEqual({
			_tag: "Next",
			state: turn({ status: "cancelled", cancelRequested: true }),
			followUp: FollowUp.End({ userMessage: TURN_CANCELLED }),
		});
		expect(transition(turn(), TurnEvent.CancelWaiting())._tag).toBe("Refused");
	});

	it("cancels a waiting turn when its routine run ends, and only asks a running one to stop", () => {
		expect(transition(turn({ status: "waiting" }), TurnEvent.RoutineEnded())).toEqual({
			_tag: "Next",
			state: turn({ status: "cancelled", cancelRequested: true }),
			followUp: FollowUp.End({ userMessage: ROUTINE_EXECUTION_ENDED }),
		});
		expect(transition(turn(), TurnEvent.RoutineEnded())).toEqual({
			_tag: "Next",
			state: turn({ cancelRequested: true }),
			followUp: FollowUp.AnnounceCancelRequest(),
		});
	});
});

describe("running a failed turn again", () => {
	it("happens while no checkpoint or change stands in the way and runs are left", () => {
		expect(runsAgainAfterFailure(turn(), false)).toBe(true);
		expect(runsAgainAfterFailure(turn({ runs: MAX_TURN_RUNS }), false)).toBe(false);
	});

	// ADR 002: running it again could make the change a second time.
	it("does not happen once the turn has a checkpoint or a tool that changes things ran", () => {
		expect(runsAgainAfterFailure(turn({ checkpointed: true }), false)).toBe(false);
		expect(runsAgainAfterFailure(turn(), true)).toBe(false);
		expect(runsAgainAfterFailure(turn({ mutationStarted: true }), false)).toBe(false);
	});
});
