import { type UserText, userText } from "@sugabots/errors";
import { Data } from "effect";
import type { TurnStatus } from "../../database/schema.ts";

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

/** What people are told of a cancelled turn's tool calls that were cut short. */
export const TURN_CANCELLED = userText`Turn cancelled`;

/** What people are told of a turn's tool calls cut short because its automation run ended. */
export const RUN_ENDED = userText`Automation run ended`;

/** What people are told of a turn a defect ended, rather than a failure it expects. */
export const TURN_STOPPED_UNEXPECTEDLY = userText`The reply stopped unexpectedly.`;

/** What people are told of a system bot's turn cut short by its process stopping. */
export const SYSTEM_TURN_INTERRUPTED = userText`It was interrupted before it finished.`;

/** What the lifecycle knows of a turn besides its status. */
interface TurnFacts {
	/** The workflow execution running the turn. A suspended turn resumes only for its owner. */
	readonly owner: string | null;
	readonly cancelRequested: boolean;
	/** Runs since the turn last got anywhere; see `MAX_TURN_RUNS`. */
	readonly runs: number;
	/** Whether a model transcript is parked to continue from after approvals. */
	readonly checkpointed: boolean;
	/** A write/delete tool call crossed its dispatch boundary. */
	readonly writeOrDeleteStarted: boolean;
}

export type TurnState = TurnFacts &
	(
		| { readonly status: Exclude<TurnStatus, "failed"> }
		/** `userMessage` is what people are told went wrong. */
		| { readonly status: "failed"; readonly userMessage: UserText }
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
	 * Another run of the turn is starting, for the workflow execution `owner`.
	 * `uncertainWriteOrDelete` is whether a write/delete tool call was left running, so
	 * whether it happened is unknown.
	 */
	Reopen: { readonly owner: string | null; readonly uncertainWriteOrDelete: boolean };
	/** The reply stopped to wait for people to decide tool approvals. */
	Suspend: Record<never, never>;
	Complete: Record<never, never>;
	Fail: { readonly userMessage: UserText };
	/** The run stopped short, as it was asked to. */
	Cancel: Record<never, never>;
	/**
	 * The turn ends without running again: its owner gave up on it, or it may
	 * not run. `userMessage` is what people are told of it and of its
	 * unfinished tool calls.
	 */
	Abandon: { readonly status: "failed" | "cancelled"; readonly userMessage: UserText };
	/** The workflow of a waiting turn heard the cancellation, and stops waiting. */
	CancelWaiting: Record<never, never>;
	/** The automation run the turn works for ended. */
	AutomationEnded: Record<never, never>;
}>;

export const TurnEvent = Data.taggedEnum<TurnEvent>();

/** What the store does besides writing the next state. */
export type FollowUp = Data.TaggedEnum<{
	/** Continue the parked reply from its checkpoint. */
	Resume: Record<never, never>;
	/** Start the reply again: its text and the calls it made go. */
	Retry: Record<never, never>;
	/**
	 * The turn ended mid-run: its reply and unfinished tool calls end with it,
	 * and people are told `userMessage` of the calls.
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
		Reopen: ({ owner, uncertainWriteOrDelete }) => reopen(state, owner, uncertainWriteOrDelete),
		Suspend: () =>
			mayRunTools(state)
				? next({ ...factsOf(state), status: "waiting", checkpointed: true, runs: 0 })
				: refused("The turn is not running, or was asked to stop"),
		Complete: () =>
			isActive(state) ? next({ ...factsOf(state), status: "done", checkpointed: false }) : ended,
		Fail: ({ userMessage }) => (isActive(state) ? next(failed(state, userMessage)) : ended),
		Cancel: () => (isActive(state) ? next(cancelled(state)) : ended),
		Abandon: ({ status, userMessage }) =>
			isActive(state)
				? next(
						status === "failed" ? failed(state, userMessage) : cancelled(state),
						FollowUp.End({ userMessage }),
					)
				: ended,
		CancelWaiting: () =>
			state.status === "waiting"
				? next(
						{ ...cancelled(state), cancelRequested: true },
						FollowUp.End({ userMessage: TURN_CANCELLED }),
					)
				: refused("The turn is not waiting"),
		// A running turn is only asked to stop: its workflow holds the reply, and
		// records how it ended. A waiting one has nobody to do that.
		AutomationEnded: () => {
			if (state.status === "waiting") {
				return next(
					{ ...cancelled(state), cancelRequested: true },
					FollowUp.End({ userMessage: RUN_ENDED }),
				);
			}
			if (state.status === "running") {
				return next(
					{ ...factsOf(state), status: "running", cancelRequested: true },
					FollowUp.AnnounceCancelRequest(),
				);
			}
			return ended;
		},
	});
}

/**
 * runsAgainAfterFailure reports whether a turn in `state` runs again after
 * its run fails: not once it has a checkpoint or a tool that changes things
 * started, since running again could do it again, and not once it has run
 * `MAX_TURN_RUNS` times.
 */
export const runsAgainAfterFailure = (state: TurnState): boolean =>
	!state.checkpointed && !state.writeOrDeleteStarted && state.runs < MAX_TURN_RUNS;

/** mayRunTools reports whether the turn may start a tool: it is running and nobody asked it to stop. */
export const mayRunTools = (state: Pick<TurnState, "status" | "cancelRequested">): boolean =>
	state.status === "running" && !state.cancelRequested;

/** awaitsDecisions reports whether people may decide the turn's approvals: it waits on them and nobody asked it to stop. */
export const awaitsDecisions = (state: Pick<TurnState, "status" | "cancelRequested">): boolean =>
	state.status === "waiting" && !state.cancelRequested;

/** endedAs returns how a turn in the ended `state` settles its automation run. */
export function endedAs(state: TurnState): Ended {
	return state.status === "failed"
		? { state: "failed", error: state.userMessage }
		: { state: "cancelled" };
}

/** Told when the lifecycle finds a turn stopped with a write/delete tool call it may have made. */
const UNCERTAIN_WRITE_OR_DELETE = userText`The reply stopped after a tool that can make changes may have run, so it was not started again. Check what the tool did before asking again.`;

const ended = refused("The turn has already ended");

function reopen(
	state: TurnState,
	owner: string | null,
	uncertainWriteOrDelete: boolean,
): Transition {
	if (state.status === "done" || state.status === "cancelled") return ended;
	if (state.cancelRequested) {
		return next(cancelled(state), FollowUp.End({ userMessage: TURN_CANCELLED }));
	}
	if (state.writeOrDeleteStarted && (!state.checkpointed || uncertainWriteOrDelete)) {
		return next(
			failed(state, UNCERTAIN_WRITE_OR_DELETE),
			FollowUp.End({ userMessage: UNCERTAIN_WRITE_OR_DELETE }),
		);
	}
	if (state.runs >= MAX_TURN_RUNS) {
		const gaveUp = userText`The turn stopped ${state.runs} times before it could finish`;
		return next(failed(state, gaveUp), FollowUp.End({ userMessage: gaveUp }));
	}
	if (state.checkpointed) {
		if (!isActive(state) || state.owner !== owner) {
			return refused("The suspended turn no longer belongs to this workflow");
		}
		return next({ ...factsOf(state), status: "running", runs: state.runs + 1 }, FollowUp.Resume());
	}
	return next(
		{ ...factsOf(state), status: "running", owner, checkpointed: false, runs: state.runs + 1 },
		FollowUp.Retry(),
	);
}

function factsOf(state: TurnState): TurnFacts {
	return {
		owner: state.owner,
		cancelRequested: state.cancelRequested,
		runs: state.runs,
		checkpointed: state.checkpointed,
		writeOrDeleteStarted: state.writeOrDeleteStarted,
	};
}

/** The turn ended as failed, which drops its checkpoint. */
function failed(state: TurnState, userMessage: UserText): TurnState {
	return { ...factsOf(state), status: "failed", userMessage, checkpointed: false };
}

/** The turn ended as cancelled, which drops its checkpoint and is not an error. */
function cancelled(state: TurnState): TurnState {
	return { ...factsOf(state), status: "cancelled", checkpointed: false };
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
