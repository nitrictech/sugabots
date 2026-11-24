import { userText } from "@sugabots/errors";
import { describe, expect, it } from "vitest";
import {
	FollowUp,
	MAX_TURN_RUNS,
	RUN_ENDED,
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

const executionId = "workflow-execution-1";
const providerDown = userText`The model provider could not answer.`;

const facts = {
	executionId,
	interruptRequested: false,
	runs: 1,
	checkpointed: false,
	writeOrDeleteStarted: false,
};

function turn(
	overrides: Partial<typeof facts> & { status?: "running" | "waiting" | "done" | "cancelled" } = {},
): TurnState {
	return { status: "running", ...facts, ...overrides };
}

function failedTurn(overrides: Partial<typeof facts> = {}): TurnState {
	return { status: "failed", userMessage: providerDown, ...facts, ...overrides };
}

const reopen = (state: TurnState, uncertainWriteOrDelete = false) =>
	transition(state, TurnEvent.Reopen({ executionId, uncertainWriteOrDelete }));

describe("reopening a turn for another run", () => {
	it("starts the reply again for a turn that failed", () => {
		expect(reopen(failedTurn())).toEqual({
			_tag: "Next",
			state: turn({ runs: 2 }),
			followUp: FollowUp.Retry(),
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
			reopen(turn({ status: "waiting", checkpointed: true, executionId: "another-execution" })),
		).toMatchObject({ _tag: "Refused" });
	});

	it("refuses a turn that is done or cancelled", () => {
		expect(reopen(turn({ status: "done" }))).toMatchObject({ _tag: "Refused" });
		expect(reopen(turn({ status: "cancelled" }))).toMatchObject({ _tag: "Refused" });
	});

	it("ends as cancelled a turn somebody asked to stop", () => {
		expect(reopen(turn({ interruptRequested: true }))).toEqual({
			_tag: "Next",
			state: turn({ status: "cancelled", interruptRequested: true }),
			followUp: FollowUp.End({ userMessage: TURN_CANCELLED }),
		});
	});

	// Running it again could make the change a second time.
	it("ends as failed a turn whose write/delete tool call may have run without a checkpoint", () => {
		expect(reopen(turn({ writeOrDeleteStarted: true }))).toMatchObject({
			_tag: "Next",
			state: {
				status: "failed",
				userMessage: expect.stringContaining("tool that can make changes"),
			},
			followUp: { _tag: "End" },
		});
	});

	it("ends as failed a checkpointed turn whose write/delete tool call was left running", () => {
		const state = turn({ status: "waiting", checkpointed: true, writeOrDeleteStarted: true });
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
			followUp: FollowUp.Retry(),
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
		expect(transition(turn({ interruptRequested: true }), TurnEvent.Suspend())._tag).toBe(
			"Refused",
		);
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
		const stopped = userText`The reply stopped unexpectedly.`;
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
	it("records a waiting turn as cancelled when its workflow stops waiting", () => {
		expect(
			transition(turn({ status: "waiting", checkpointed: true }), TurnEvent.CancelWaiting()),
		).toEqual({
			_tag: "Next",
			state: turn({ status: "cancelled", interruptRequested: true }),
			followUp: FollowUp.End({ userMessage: TURN_CANCELLED }),
		});
		expect(transition(turn(), TurnEvent.CancelWaiting())._tag).toBe("Refused");
	});

	it("cancels a waiting turn when its automation run ends, and only asks a running one to stop", () => {
		expect(transition(turn({ status: "waiting" }), TurnEvent.AutomationEnded())).toEqual({
			_tag: "Next",
			state: turn({ status: "cancelled", interruptRequested: true }),
			followUp: FollowUp.End({ userMessage: RUN_ENDED }),
		});
		expect(transition(turn(), TurnEvent.AutomationEnded())).toEqual({
			_tag: "Next",
			state: turn({ interruptRequested: true }),
			followUp: FollowUp.AnnounceCancelRequest(),
		});
	});
});

describe("running a failed turn again", () => {
	it("happens while no checkpoint or change stands in the way and runs are left", () => {
		expect(runsAgainAfterFailure(turn())).toBe(true);
		expect(runsAgainAfterFailure(turn({ runs: MAX_TURN_RUNS }))).toBe(false);
	});

	// Running it again could make the change a second time.
	it("does not happen once the turn has a checkpoint or a tool that changes things started", () => {
		expect(runsAgainAfterFailure(turn({ checkpointed: true }))).toBe(false);
		expect(runsAgainAfterFailure(turn({ writeOrDeleteStarted: true }))).toBe(false);
	});
});
