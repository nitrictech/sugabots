import type { JsonValue, ToolApprovalStatus, ToolCallStatus } from "@sugabots/contracts";
import { Data, Schema } from "effect";
import type { UserMessage } from "../../../user-message.ts";

/**
 * A tool call's lifecycle, as a pure transition function.
 *
 * A built-in tool's call opens `running` and closes `completed` or `failed`.
 * A connection tool's call is parked first, `awaiting_approval` with its
 * approval `pending`: a person decides it, an allowed call then
 * runs, and a denied one completes with the denial as its output. A call
 * still open when its turn ends fails, and a pending approval is denied.
 * `ToolCallRepository` loads a call, asks `transition` what the event makes of
 * it, and writes the answer.
 */

/** The statuses of a call that has not finished. */
export const UNFINISHED_STATUSES = [
	"running",
	"awaiting_approval",
] as const satisfies readonly ToolCallStatus[];

/** A person's decision on one approval, as it is recorded and sent to the turn's workflow. */
export const ApprovalDecision = Schema.Struct({
	decision: Schema.Literals(["allow_once", "deny"]),
	userId: Schema.String,
});
export type ApprovalDecision = typeof ApprovalDecision.Type;

/** A decision on one of a turn's approvals, named by the approval it decides. */
export const DecidedApproval = Schema.Struct({
	approvalId: Schema.String,
	decision: ApprovalDecision,
});
export type DecidedApproval = typeof DecidedApproval.Type;

export interface ToolCallState {
	readonly status: ToolCallStatus;
	/** `null` for a call that needed nobody's approval. */
	readonly approvalStatus: ToolApprovalStatus | null;
	/** Who made the decision. */
	readonly decidedById: string | null;
	readonly output: JsonValue | null;
	readonly error: UserMessage | null;
}

export type ToolCallEvent = Data.TaggedEnum<{
	/** The tool returned, or threw. */
	Close: { readonly outcome: { output: JsonValue } | { error: UserMessage } };
	/** The decision was recorded. */
	Decide: { readonly decision: ApprovalDecision };
	/** The allowed call began running. */
	BeginExecution: Record<never, never>;
	/** The call's turn ended before it finished; `userMessage` is what people are told of it. */
	Abandon: { readonly userMessage: UserMessage };
}>;

export const ToolCallEvent = Data.taggedEnum<ToolCallEvent>();

export type Transition =
	| { readonly _tag: "Next"; readonly state: ToolCallState }
	| { readonly _tag: "Refused"; readonly reason: string };

/** What a denied call's output says, for the model to read. */
export const DENIED_OUTPUT = { status: "denied", reason: "A person denied this action" };

export function transition(state: ToolCallState, event: ToolCallEvent): Transition {
	return ToolCallEvent.$match(event, {
		Close: ({ outcome }) => {
			if (state.status !== "running") return refused("The call is not running");
			return next(
				"error" in outcome
					? { ...state, status: "failed", output: null, error: outcome.error }
					: { ...state, status: "completed", output: outcome.output, error: null },
			);
		},
		Decide: ({ decision }) => {
			if (!awaitsDecision(state)) return refused("The call has already been decided");
			if (decision.decision === "deny") {
				return next({
					...state,
					approvalStatus: "denied",
					decidedById: decision.userId,
					status: "completed",
					output: DENIED_OUTPUT,
				});
			}
			return next({ ...state, approvalStatus: "allowed", decidedById: decision.userId });
		},
		BeginExecution: () =>
			state.approvalStatus === "allowed" && state.status === "awaiting_approval"
				? next({ ...state, status: "running" })
				: refused("The call is not approved for execution"),
		// A pending approval becomes denied: nobody may allow a call whose turn is over.
		Abandon: ({ userMessage }) => {
			if (isFinished(state.status)) return refused("The call has already finished");
			return next({
				...state,
				status: "failed",
				approvalStatus: state.approvalStatus === "pending" ? "denied" : state.approvalStatus,
				error: userMessage,
			});
		},
	});
}

/** awaitsDecision reports whether the call's approval waits for a person's decision. */
export const awaitsDecision = (state: Pick<ToolCallState, "approvalStatus">): boolean =>
	state.approvalStatus === "pending";

/** isFinished reports whether a call with this status has finished, one way or another. */
export const isFinished = (status: ToolCallStatus): boolean =>
	status === "completed" || status === "failed";

function next(state: ToolCallState): Transition {
	return { _tag: "Next", state };
}

function refused(reason: string): Transition {
	return { _tag: "Refused", reason };
}
