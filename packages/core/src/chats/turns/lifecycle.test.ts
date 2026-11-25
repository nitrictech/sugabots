import { userText } from "@sugabots/errors";
import { describe, expect, it } from "vitest";
import {
	ENDED_BEFORE_IT_RAN,
	FollowUp,
	MAX_TURN_RUNS,
	RUN_ENDED,
	runsAgainAfterFailure,
	TURN_CANCELLED,
	TURN_INTERRUPTED,
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

const facts: Omit<TurnFactsForTests, "status"> = {
	executionId,
	endRequested: null,
	runs: 1,
	waited: false,
	writeOrDeleteStarted: false,
};

function turn(
	overrides: Partial<typeof facts> & { status?: "running" | "waiting" | "done" | "cancelled" } = {},
): TurnState {
	return { status: "running", ...facts, ...overrides };
}

function failedTurn(overrides: Partial<typeof facts & { retrying: boolean }> = {}): TurnState {
	return { status: "failed", userMessage: providerDown, retrying: false, ...facts, ...overrides };
}

type TurnFactsForTests = Pick<
	TurnState,
	"executionId" | "endRequested" | "runs" | "waited" | "writeOrDeleteStarted" | "status"
>;

const reopen = (state: TurnState) => transition(state, TurnEvent.Reopen({ executionId }));

describe("reopening a turn for another run", () => {
	it("starts the reply again for a turn that failed", () => {
		expect(reopen(failedTurn())).toEqual({
			_tag: "Next",
			state: turn({ runs: 2 }),
			followUp: FollowUp.Retry(),
		});
	});

	it("carries a turn its run opened before a crash on from its checkpoint, for the workflow that owns it", () => {
		expect(reopen(turn({ status: "waiting", waited: true, runs: 0 }))).toEqual({
			_tag: "Next",
			state: turn({ status: "waiting", waited: true, runs: 1 }),
			followUp: FollowUp.Resume(),
		});
		expect(reopen(turn({ writeOrDeleteStarted: true }))).toMatchObject({
			_tag: "Next",
			followUp: FollowUp.Resume(),
		});
	});

	it("refuses to carry on a turn for another workflow", () => {
		expect(
			reopen(turn({ status: "waiting", waited: true, executionId: "another-execution" })),
		).toMatchObject({ _tag: "Refused" });
	});

	it("refuses a turn that is done or cancelled", () => {
		expect(reopen(turn({ status: "done" }))).toMatchObject({ _tag: "Refused" });
		expect(reopen(turn({ status: "cancelled" }))).toMatchObject({ _tag: "Refused" });
	});

	it("ends as cancelled a turn somebody interrupted", () => {
		expect(reopen(turn({ endRequested: "interrupted" }))).toEqual({
			_tag: "Next",
			state: turn({ status: "cancelled", endRequested: "interrupted" }),
			followUp: FollowUp.End({ userMessage: TURN_INTERRUPTED }),
		});
	});

	// Running it again could make the change a second time.
	it("ends as failed, rather than runs again, a failed turn whose write/delete tool call may have run", () => {
		expect(reopen(failedTurn({ writeOrDeleteStarted: true }))).toMatchObject({
			_tag: "Next",
			state: {
				status: "failed",
				userMessage: expect.stringContaining("tool that can make changes"),
			},
			followUp: { _tag: "End" },
		});
	});

	it("gives up on a turn that has stopped as many times as it may run", () => {
		expect(reopen(turn({ runs: MAX_TURN_RUNS }))).toMatchObject({
			_tag: "Next",
			state: {
				status: "failed",
				userMessage: `The turn stopped ${MAX_TURN_RUNS} times before it could finish`,
			},
		});
		expect(reopen(failedTurn({ runs: MAX_TURN_RUNS - 1 }))).toMatchObject({
			followUp: FollowUp.Retry(),
		});
	});
});

describe("beginning a step", () => {
	it("begins a running turn's step as it is", () => {
		expect(transition(turn(), TurnEvent.BeginStep({ again: false }))).toEqual({
			_tag: "Next",
			state: turn(),
		});
	});

	it("counts a step begun again after a crash, and gives up once the turn has stopped too often", () => {
		expect(transition(turn(), TurnEvent.BeginStep({ again: true }))).toEqual({
			_tag: "Next",
			state: turn({ runs: 2 }),
		});
		expect(
			transition(turn({ runs: MAX_TURN_RUNS - 1 }), TurnEvent.BeginStep({ again: true })),
		).toMatchObject({
			_tag: "Next",
			state: {
				status: "failed",
				userMessage: `The turn stopped ${MAX_TURN_RUNS} times before it could finish`,
			},
			followUp: { _tag: "End" },
		});
	});

	it("cancels a turn somebody interrupted between its steps, ending its run", () => {
		expect(
			transition(turn({ endRequested: "interrupted" }), TurnEvent.BeginStep({ again: false })),
		).toMatchObject({
			_tag: "Next",
			state: { status: "cancelled", endRequested: "interrupted" },
			followUp: FollowUp.End({ userMessage: TURN_INTERRUPTED }),
		});
	});

	it("refuses a turn no longer running", () => {
		expect(
			transition(turn({ status: "waiting" }), TurnEvent.BeginStep({ again: false }))._tag,
		).toBe("Refused");
	});
});

describe("suspending for approvals", () => {
	it("parks a running turn and starts its run count again", () => {
		expect(transition(turn({ runs: 2 }), TurnEvent.Suspend())).toEqual({
			_tag: "Next",
			state: turn({ status: "waiting", waited: true, runs: 0 }),
		});
	});

	it("runs a waiting turn on once its approvals are decided, unless somebody asked it to stop", () => {
		expect(
			transition(turn({ status: "waiting", waited: true }), TurnEvent.ResumeAfterApprovals()),
		).toEqual({ _tag: "Next", state: turn({ waited: true }) });
		expect(
			transition(
				turn({ status: "waiting", endRequested: "interrupted" }),
				TurnEvent.ResumeAfterApprovals(),
			)._tag,
		).toBe("Refused");
		expect(transition(turn(), TurnEvent.ResumeAfterApprovals())._tag).toBe("Refused");
	});

	it("refuses a turn somebody asked to stop, or one no longer running", () => {
		expect(transition(turn({ endRequested: "interrupted" }), TurnEvent.Suspend())._tag).toBe(
			"Refused",
		);
		expect(transition(failedTurn(), TurnEvent.Suspend())._tag).toBe("Refused");
	});
});

describe("ending a run", () => {
	it("completes, fails or cancels a running turn", () => {
		const running = turn();
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
	it("cancels a waiting turn as it does a running one, once its workflow stops waiting", () => {
		expect(transition(turn({ status: "waiting", waited: true }), TurnEvent.Cancel())).toEqual({
			_tag: "Next",
			state: turn({ status: "cancelled", waited: true }),
		});
	});

	it("cancels a waiting turn when its automation run ends, and only asks a running one to stop", () => {
		expect(transition(turn({ status: "waiting" }), TurnEvent.AutomationEnded())).toEqual({
			_tag: "Next",
			state: turn({ status: "cancelled", endRequested: "run_ended" }),
			followUp: FollowUp.End({ userMessage: RUN_ENDED }),
		});
		expect(transition(turn(), TurnEvent.AutomationEnded())).toEqual({
			_tag: "Next",
			state: turn({ endRequested: "run_ended" }),
			followUp: FollowUp.AnnounceCancelRequest(),
		});
	});

	it("cancels a failed turn waiting to retry when its automation run ends", () => {
		expect(transition(failedTurn({ retrying: true }), TurnEvent.AutomationEnded())).toEqual({
			_tag: "Next",
			state: turn({ status: "cancelled", endRequested: "run_ended" }),
			followUp: FollowUp.End({ userMessage: RUN_ENDED }),
		});
		expect(transition(failedTurn(), TurnEvent.AutomationEnded())._tag).toBe("Refused");
	});
});

describe("ending a turn asked to end", () => {
	it.each([
		["interrupted", TURN_INTERRUPTED],
		["run_ended", RUN_ENDED],
		["lost_reach", ENDED_BEFORE_IT_RAN],
		["approval_expired", ENDED_BEFORE_IT_RAN],
	] as const)("tells members of its unfinished calls why, when it was %s", (endRequested, said) => {
		const asked = turn({ status: "waiting", endRequested });
		const ended = { _tag: "Next", state: { ...asked, status: "cancelled" } };
		expect(transition(asked, TurnEvent.EndAsRequested())).toEqual({
			...ended,
			followUp: FollowUp.End({ userMessage: said }),
		});
		expect(transition(turn({ endRequested }), TurnEvent.BeginStep({ again: false }))).toEqual({
			_tag: "Next",
			state: turn({ status: "cancelled", endRequested }),
			followUp: FollowUp.End({ userMessage: said }),
		});
	});

	it("keeps the first reason it was asked to end for", () => {
		expect(transition(turn({ endRequested: "run_ended" }), TurnEvent.Interrupt())).toMatchObject({
			state: { endRequested: "run_ended" },
		});
	});
});

describe("running a failed turn again", () => {
	it("happens while no approval or change stands in the way and runs are left", () => {
		expect(runsAgainAfterFailure(turn())).toBe(true);
		expect(runsAgainAfterFailure(turn({ runs: MAX_TURN_RUNS }))).toBe(false);
	});

	// Running it again could make the change a second time.
	it("does not happen once the turn has waited for approvals or a tool that changes things started", () => {
		expect(runsAgainAfterFailure(turn({ waited: true }))).toBe(false);
		expect(runsAgainAfterFailure(turn({ writeOrDeleteStarted: true }))).toBe(false);
	});
});
