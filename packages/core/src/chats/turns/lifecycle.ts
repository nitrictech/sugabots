import { UserText, userText } from "@sugabots/errors";
import { type Cause, Data, Effect } from "effect";
import type { TurnEndRequest, TurnStatus } from "../../database/schema.ts";
import { TURN_INTERRUPTED } from "../tool-call-end-messages.ts";

export { TURN_CANCELLED, TURN_INTERRUPTED } from "../tool-call-end-messages.ts";

/**
 * A turn's lifecycle, as a pure transition function.
 *
 * A turn is `running` while a segment streams its reply, `waiting` while it is
 * parked for tool approvals, and ends `done`, `failed` or `cancelled`. A
 * `failed` turn may be opened again for another run; `done` and `cancelled`
 * are final. `TurnStore` loads a turn, asks `transition` what the event
 * makes of it, and writes the answer.
 */

/**
 * How many times a turn may run without getting anywhere before it is given
 * up on. `runs` counts every run that opens the turn, including one a crash
 * cut short, and restarts from zero when the turn suspends.
 */
export const MAX_TURN_RUNS = 3;

/** What members are told of a turn's tool calls cut short because its automation run ended. */
export const RUN_ENDED = userText`Automation run ended`;

/**
 * What members are told of a turn's tool calls left unmade because it ended
 * first, as when its asker or bot lost the chat or an approval expired.
 */
export const ENDED_BEFORE_IT_RAN = userText`The turn ended before this ran`;

/** What members are told of a turn's tool calls cut short when it ended early for no reason it kept. */
const ENDED_BEFORE_IT_FINISHED = userText`The turn ended before this finished`;

/**
 * What members are told of the tool calls a turn ended early left
 * unfinished, by why it was asked to end (see `TurnEndRequest`). A turn loses
 * its chat or an approval only while it waits, when none of its calls runs.
 */
export function unfinishedCallsMessage(request: TurnEndRequest | null): UserText {
	switch (request) {
		case "interrupted":
			return TURN_INTERRUPTED;
		case "run_ended":
			return RUN_ENDED;
		case "lost_reach":
		case "approval_expired":
			return ENDED_BEFORE_IT_RAN;
		case null:
			return ENDED_BEFORE_IT_FINISHED;
	}
}

/** turnStoppedUnexpectedly tells members how to find a turn's defect in the log. */
export const turnStoppedUnexpectedly = (referenceId: string): UserText =>
	UserText.unchecked(`The reply stopped unexpectedly. Reference: ${referenceId}.`);

/** logTurnDefect logs the full cause and returns the user message with the same reference id. */
export const logTurnDefect = (referenceId: string, message: string, cause: Cause.Cause<unknown>) =>
	Effect.as(Effect.logError(message, { referenceId }, cause), turnStoppedUnexpectedly(referenceId));

/** What members are told of a system bot's turn cut short by its process stopping. */
export const SYSTEM_TURN_INTERRUPTED = userText`It was interrupted before it finished.`;

/** What the lifecycle knows of a turn besides its status. */
interface TurnFacts {
	/** The workflow execution running the turn. A turn is opened again only by that execution. */
	readonly executionId: string | null;
	/** Why the turn was asked to end, if it was; it then runs no more tools. */
	readonly endRequested: TurnEndRequest | null;
	/** Runs since the turn last got anywhere; see `MAX_TURN_RUNS`. */
	readonly runs: number;
	/** Whether the turn has waited for approvals, which members gave for this run of it. */
	readonly waited: boolean;
	/** A write/delete tool call crossed its dispatch boundary. */
	readonly writeOrDeleteStarted: boolean;
}

export type TurnState = TurnFacts &
	(
		| { readonly status: Exclude<TurnStatus, "failed"> }
		/** `userMessage` is what members are told went wrong. */
		| { readonly status: "failed"; readonly userMessage: UserText; readonly retrying: boolean }
	);

/**
 * How a turn ended part-way through a run, which is how an automation run it
 * belonged to settles.
 */
export type Ended =
	| { readonly state: "failed"; readonly error: UserText }
	| { readonly state: "cancelled" };

export type TurnEvent = Data.TaggedEnum<{
	/**
	 * Another run of the turn is starting, for the workflow execution
	 * `executionId`: a retry of a failed turn, or the same run opening it
	 * again after a crash before its steps began.
	 */
	Reopen: { readonly executionId: string | null };
	/**
	 * A step begins. `again` when the step had begun before and a crash cut it
	 * short, which counts as a run that got nowhere.
	 */
	BeginStep: { readonly again: boolean };
	/** The reply stopped to wait for members to decide tool approvals. */
	Suspend: Record<never, never>;
	/** Every approval the turn waited for is decided, so its steps run on. */
	ResumeAfterApprovals: Record<never, never>;
	Complete: Record<never, never>;
	Fail: { readonly userMessage: UserText };
	/** The run stopped short, as it was asked to, running or waiting. */
	Cancel: Record<never, never>;
	/**
	 * The turn ends without running again: its workflow execution gave up on it, or it may
	 * not run. `userMessage` is what members are told of it and of its
	 * unfinished tool calls.
	 */
	Abandon: { readonly status: "failed" | "cancelled"; readonly userMessage: UserText };
	/** The automation run the turn works for ended. */
	AutomationEnded: Record<never, never>;
	/** A member interrupted the turn. */
	Interrupt: Record<never, never>;
	/**
	 * The workflow running the turn heard it was asked to end, and ends it,
	 * telling members of its unfinished tool calls why.
	 */
	EndAsRequested: Record<never, never>;
}>;

export const TurnEvent = Data.taggedEnum<TurnEvent>();

/** What the store does besides writing the next state. */
export type FollowUp = Data.TaggedEnum<{
	/** Carry the run on from its checkpoint. */
	Resume: Record<never, never>;
	/** Start the reply again: its text and the calls it made go. */
	Retry: Record<never, never>;
	/**
	 * The turn ended mid-run: its reply and unfinished tool calls end with it,
	 * and members are told `userMessage` of the calls.
	 */
	End: { readonly userMessage: UserText };
	/** Tell the workflow running the turn to stop. */
	AnnounceCancelRequest: Record<never, never>;
}>;

export const FollowUp = Data.taggedEnum<FollowUp>();

export type Transition =
	| { readonly _tag: "Next"; readonly state: TurnState; readonly followUp?: FollowUp }
	/** `reason` is for the logs. */
	| { readonly _tag: "Refused"; readonly reason: string };

export function transition(state: TurnState, event: TurnEvent): Transition {
	return TurnEvent.$match(event, {
		Reopen: ({ executionId }) => reopen(state, executionId),
		BeginStep: ({ again }) => beginStep(state, again),
		Suspend: () =>
			mayRunTools(state)
				? next({ ...factsOf(state), status: "waiting", waited: true, runs: 0 })
				: refused("The turn is not running, or was asked to stop"),
		ResumeAfterApprovals: () =>
			awaitsDecisions(state)
				? next({ ...factsOf(state), status: "running" })
				: refused("The turn is not waiting, or was asked to stop"),
		Complete: () => (isActive(state) ? next({ ...factsOf(state), status: "done" }) : ended),
		Fail: ({ userMessage }) => (isActive(state) ? next(failed(state, userMessage)) : ended),
		Cancel: () => (isActive(state) ? next(cancelled(state)) : ended),
		Abandon: ({ status, userMessage }) => {
			if (state.status === "failed" && state.retrying) {
				const error = status === "failed" ? userMessage : state.userMessage;
				return next(failed(state, error), FollowUp.End({ userMessage: error }));
			}
			if (!isActive(state)) return ended;
			if (state.endRequested) return endAsRequested(state);
			return next(
				status === "failed" ? failed(state, userMessage) : cancelled(state),
				FollowUp.End({ userMessage }),
			);
		},
		AutomationEnded: () => requestEnd(state, "run_ended"),
		Interrupt: () => requestEnd(state, "interrupted"),
		EndAsRequested: () => (isActive(state) ? endAsRequested(state) : ended),
	});
}

/**
 * Asks the turn to end, for `request`: one waiting for approvals or to run
 * again ends at once, and a running one is marked, which the step under way
 * hears and the next step finds. A turn asked once keeps the first reason.
 */
function requestEnd(state: TurnState, request: TurnEndRequest): Transition {
	const endRequested = state.endRequested ?? request;
	if (state.status === "waiting" || (state.status === "failed" && state.retrying)) {
		return endAsRequested({ ...state, endRequested });
	}
	if (state.status === "running") {
		return next(
			{ ...factsOf(state), status: "running", endRequested },
			FollowUp.AnnounceCancelRequest(),
		);
	}
	return ended;
}

/** Ends the turn as it was asked to, telling members why of its unfinished tool calls. */
function endAsRequested(state: TurnState): Transition {
	return next(
		cancelled(state),
		FollowUp.End({ userMessage: unfinishedCallsMessage(state.endRequested) }),
	);
}

/**
 * runsAgainAfterFailure reports whether a turn in `state` runs again after
 * its run fails. A retry requires runs left, no interrupt request, no wait
 * for approvals, and no write/delete tool call started.
 */
export const runsAgainAfterFailure = (state: TurnState): boolean =>
	state.endRequested === null &&
	!state.waited &&
	!state.writeOrDeleteStarted &&
	state.runs < MAX_TURN_RUNS;

/** mayRunTools reports whether the turn may start a tool: it is running and was not asked to stop. */
export const mayRunTools = (state: Pick<TurnState, "status" | "endRequested">): boolean =>
	state.status === "running" && state.endRequested === null;

/** awaitsDecisions reports whether members may decide the turn's approvals: it waits on them and was not asked to stop. */
export const awaitsDecisions = (state: Pick<TurnState, "status" | "endRequested">): boolean =>
	state.status === "waiting" && state.endRequested === null;

/** endedAs returns how a turn in the ended `state` settles its automation run. */
export function endedAs(state: TurnState): Ended {
	return state.status === "failed"
		? { state: "failed", error: state.userMessage }
		: { state: "cancelled" };
}

/** Told when the lifecycle finds a failed turn that a write/delete tool call may have changed things for. */
export const UNCERTAIN_WRITE_OR_DELETE = userText`The reply stopped after a tool that can make changes may have run, so it was not started again. Check what the tool did before asking again.`;

const ended = refused("The turn has already ended");

/** What members are told of a turn that stopped `runs` times before it could finish. */
export const gaveUpAfter = (runs: number) =>
	userText`The turn stopped ${runs} times before it could finish`;

function reopen(state: TurnState, executionId: string | null): Transition {
	if (state.status === "done" || state.status === "cancelled") return ended;
	if (state.endRequested) return endAsRequested(state);
	if (state.status === "failed" && state.writeOrDeleteStarted) {
		return next(
			failed(state, UNCERTAIN_WRITE_OR_DELETE),
			FollowUp.End({ userMessage: UNCERTAIN_WRITE_OR_DELETE }),
		);
	}
	if (state.runs >= MAX_TURN_RUNS) {
		const gaveUp = gaveUpAfter(state.runs);
		return next(failed(state, gaveUp), FollowUp.End({ userMessage: gaveUp }));
	}
	if (isActive(state)) {
		if (state.executionId !== executionId) {
			return refused("The turn belongs to another workflow");
		}
		const status = state.status === "waiting" ? "waiting" : "running";
		return next({ ...factsOf(state), status, runs: state.runs + 1 }, FollowUp.Resume());
	}
	return next(
		{
			...factsOf(state),
			status: "running",
			executionId,
			waited: false,
			runs: state.runs + 1,
		},
		FollowUp.Retry(),
	);
}

function beginStep(state: TurnState, again: boolean): Transition {
	// Asked to stop while no step ran to hear it: the step that would have run
	// ends the turn, as nothing else will.
	if (state.status === "running" && state.endRequested) return endAsRequested(state);
	if (!mayRunTools(state)) return refused("The turn is not running");
	if (!again) return next(state);
	const runs = state.runs + 1;
	if (runs >= MAX_TURN_RUNS) {
		const gaveUp = gaveUpAfter(runs);
		return next(failed(state, gaveUp), FollowUp.End({ userMessage: gaveUp }));
	}
	return next({ ...factsOf(state), status: "running", runs });
}

function factsOf(state: TurnState): TurnFacts {
	return {
		executionId: state.executionId,
		endRequested: state.endRequested,
		runs: state.runs,
		waited: state.waited,
		writeOrDeleteStarted: state.writeOrDeleteStarted,
	};
}

/** The turn ended as failed. */
function failed(state: TurnState, userMessage: UserText): TurnState {
	return { ...factsOf(state), status: "failed", userMessage, retrying: false };
}

/** The turn ended as cancelled, which is not an error. */
function cancelled(state: TurnState): TurnState {
	return { ...factsOf(state), status: "cancelled" };
}

function isActive(state: TurnState): boolean {
	return state.status === "running" || state.status === "waiting";
}

function next(state: TurnState, followUp?: FollowUp): Transition {
	return followUp ? { _tag: "Next", state, followUp } : { _tag: "Next", state };
}

function refused(reason: string): Transition {
	return { _tag: "Refused", reason };
}
