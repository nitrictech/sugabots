import { Data } from "effect";
import type { TurnStatus } from "../../database/schema.ts";
import { UserMessage } from "../../user-message.ts";

/**
 * A turn's lifecycle, as a pure transition function.
 *
 * A turn is `running` while a segment streams its reply, `waiting` while it is
 * parked for tool approvals, and ends `done`, `failed` or `cancelled`. A
 * `failed` turn may be opened again for another run; `done` and `cancelled`
 * are final. `TurnRepository` loads a turn, asks `transition` what the event
 * makes of it, and writes the answer.
 */

/**
 * How many times a turn may run without getting anywhere before it is given
 * up on. `runs` counts every run that opens the turn, including one a crash
 * cut short, and restarts from zero when the turn suspends.
 */
export const MAX_TURN_RUNS = 3;

/** The statuses of a turn somebody is still running or waiting on. */
export const ACTIVE_STATUSES = ["running", "waiting"] as const satisfies readonly TurnStatus[];

/** What people are told of a cancelled turn's tool calls that were cut short. */
export const TURN_CANCELLED = UserMessage.of`Turn cancelled`;

/** What people are told of a turn's tool calls cut short because its routine run ended. */
export const ROUTINE_EXECUTION_ENDED = UserMessage.of`Routine execution ended`;

/** What people are told of a turn a defect ended, rather than a failure it expects. */
export const TURN_STOPPED_UNEXPECTEDLY = UserMessage.of`The reply stopped unexpectedly.`;

/** What the lifecycle knows of a turn besides its status. */
interface TurnFacts {
	/** The workflow execution running the turn. A suspended turn resumes only for its owner. */
	readonly owner: string | null;
	readonly cancelRequested: boolean;
	/** Runs since the turn last got anywhere; see `MAX_TURN_RUNS`. */
	readonly runs: number;
	/** Whether a model transcript is parked to continue from after approvals. */
	readonly checkpointed: boolean;
	/** A mutating tool call crossed its dispatch boundary (ADR 002). */
	readonly mutationStarted: boolean;
}

export type TurnState = TurnFacts &
	(
		| { readonly status: Exclude<TurnStatus, "failed"> }
		/** `userMessage` is what people are told went wrong. */
		| { readonly status: "failed"; readonly userMessage: UserMessage }
	);

/**
 * How a turn ended part-way through a run, which is how a routine run it
 * belonged to settles.
 */
export type Ended =
	| { readonly state: "failed"; readonly error: UserMessage }
	| { readonly state: "cancelled" };

export type TurnEvent = Data.TaggedEnum<{
	/**
	 * Another run of the turn is starting, for the workflow execution `owner`.
	 * `uncertainMutation` is whether a mutating call was left running, so
	 * whether it happened is unknown.
	 */
	Reopen: { readonly owner: string | null; readonly uncertainMutation: boolean };
	/** The reply stopped to wait for people to decide tool approvals. */
	Suspend: Record<never, never>;
	Complete: Record<never, never>;
	Fail: { readonly userMessage: UserMessage };
	/** The run stopped short, as a person asked. */
	Cancel: Record<never, never>;
	/**
	 * The turn ends without running again: its owner gave up on it, or it may
	 * not run. `userMessage` is what people are told of it and of its
	 * unfinished tool calls.
	 */
	Abandon: { readonly status: "failed" | "cancelled"; readonly userMessage: UserMessage };
	/** A person asked the turn to stop. */
	RequestCancel: Record<never, never>;
	/** The workflow of a waiting turn heard the cancellation, and stops waiting. */
	StopWaiting: Record<never, never>;
	/** The routine run the turn works for ended. */
	RoutineEnded: Record<never, never>;
}>;

export const TurnEvent = Data.taggedEnum<TurnEvent>();

/** What the repository does besides writing the next state. */
export type FollowUp = Data.TaggedEnum<{
	/** Continue the parked reply from its checkpoint. */
	Resume: Record<never, never>;
	/** Start the reply again: its text and the calls it made go. */
	Restart: Record<never, never>;
	/**
	 * The turn ended mid-run: its reply and unfinished tool calls end with it,
	 * and people are told `userMessage` of the calls.
	 */
	End: { readonly userMessage: UserMessage };
	/** Tell the waiting turn's workflow; recording the cancellation is its job. */
	SignalOwner: { readonly owner: string };
	/** Tell the worker running the turn to stop. */
	AnnounceCancelRequest: Record<never, never>;
}>;

export const FollowUp = Data.taggedEnum<FollowUp>();

export type Transition =
	| { readonly _tag: "Next"; readonly state: TurnState; readonly followUp?: FollowUp }
	/** `reason` is for the logs. */
	| { readonly _tag: "Refused"; readonly reason: string };

export function transition(state: TurnState, event: TurnEvent): Transition {
	return TurnEvent.$match(event, {
		Reopen: ({ owner, uncertainMutation }) => reopen(state, owner, uncertainMutation),
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
		RequestCancel: () => {
			if (state.status === "waiting" && state.owner) {
				return next(
					{ ...factsOf(state), status: "waiting", cancelRequested: true },
					FollowUp.SignalOwner({ owner: state.owner }),
				);
			}
			if (mayRunTools(state)) {
				return next(
					{ ...factsOf(state), status: "running", cancelRequested: true },
					FollowUp.AnnounceCancelRequest(),
				);
			}
			return refused("The turn is not running");
		},
		StopWaiting: () =>
			state.status === "waiting"
				? next(
						{ ...cancelled(state), cancelRequested: true },
						FollowUp.End({ userMessage: TURN_CANCELLED }),
					)
				: refused("The turn is not waiting"),
		// A running turn is only asked to stop: its worker holds the reply, and
		// records how it ended. A waiting one has nobody to do that.
		RoutineEnded: () => {
			if (state.status === "waiting") {
				return next(
					{ ...cancelled(state), cancelRequested: true },
					FollowUp.End({ userMessage: ROUTINE_EXECUTION_ENDED }),
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
 * its run fails: not once it has a checkpoint or `acted` says a tool that
 * changes things ran, since running again could do it again (ADR 002), and not
 * once it has run `MAX_TURN_RUNS` times.
 */
export const runsAgainAfterFailure = (state: TurnState, acted: boolean): boolean =>
	!state.checkpointed && !acted && !state.mutationStarted && state.runs < MAX_TURN_RUNS;

/** mayRunTools reports whether the turn may start a tool: it is running and nobody asked it to stop. */
export const mayRunTools = (state: Pick<TurnState, "status" | "cancelRequested">): boolean =>
	state.status === "running" && !state.cancelRequested;

/** awaitsDecisions reports whether people may decide the turn's approvals: it waits on them and nobody asked it to stop. */
export const awaitsDecisions = (state: Pick<TurnState, "status" | "cancelRequested">): boolean =>
	state.status === "waiting" && !state.cancelRequested;

/** endedAs returns how a turn in the ended `state` settles its routine run. */
export function endedAs(state: TurnState): Ended {
	return state.status === "failed"
		? { state: "failed", error: state.userMessage }
		: { state: "cancelled" };
}

/** Told when the lifecycle finds a turn stopped with a mutating call it may have made. */
const UNCERTAIN_MUTATION = UserMessage.of`A mutating tool may have run before the worker stopped`;

const ended = refused("The turn has already ended");

function reopen(state: TurnState, owner: string | null, uncertainMutation: boolean): Transition {
	if (state.status === "done" || state.status === "cancelled") return ended;
	if (state.cancelRequested) {
		return next(cancelled(state), FollowUp.End({ userMessage: TURN_CANCELLED }));
	}
	if (state.mutationStarted && (!state.checkpointed || uncertainMutation)) {
		return next(
			failed(state, UNCERTAIN_MUTATION),
			FollowUp.End({ userMessage: UNCERTAIN_MUTATION }),
		);
	}
	if (state.runs >= MAX_TURN_RUNS) {
		const gaveUp = UserMessage.of`The turn stopped ${state.runs} times before it could finish`;
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
		FollowUp.Restart(),
	);
}

function factsOf(state: TurnState): TurnFacts {
	return {
		owner: state.owner,
		cancelRequested: state.cancelRequested,
		runs: state.runs,
		checkpointed: state.checkpointed,
		mutationStarted: state.mutationStarted,
	};
}

/** The turn ended as failed, which drops its checkpoint. */
function failed(state: TurnState, userMessage: UserMessage): TurnState {
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
