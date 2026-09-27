import { Effect, type Schema } from "effect";
import { DurableDeferred, WorkflowEngine } from "effect/unstable/workflow";
import type { ApprovalDecision } from "../tools/calls/lifecycle.ts";
import { approvalDecided, cancelRequested, Turn } from "./turn.workflow.ts";

/**
 * What people tell a turn's workflow execution while it waits for approvals.
 * Sending is the write: the workflow records each decision, and the first one
 * sent is the one that stands, so a repeated or late signal changes nothing.
 * `owner` is the turn's execution id.
 */
export interface TurnSignals {
	readonly decide: (signal: {
		readonly owner: string;
		readonly approvalId: string;
		readonly decision: ApprovalDecision;
	}) => Effect.Effect<void>;
	readonly cancel: (owner: string) => Effect.Effect<void>;
}

export const turnSignals = (engine: WorkflowEngine.WorkflowEngine["Service"]): TurnSignals => {
	const tokenFor = <Success extends Schema.Constraint>(
		deferred: DurableDeferred.DurableDeferred<Success>,
		executionId: string,
	) => DurableDeferred.tokenFromExecutionId(deferred, { workflow: Turn, executionId });
	return {
		decide: (signal) => {
			const decided = approvalDecided(signal.approvalId);
			return DurableDeferred.succeed(decided, {
				token: tokenFor(decided, signal.owner),
				value: signal.decision,
			}).pipe(Effect.provideService(WorkflowEngine.WorkflowEngine, engine));
		},
		cancel: (owner) =>
			DurableDeferred.succeed(cancelRequested, {
				token: tokenFor(cancelRequested, owner),
				value: undefined,
			}).pipe(Effect.provideService(WorkflowEngine.WorkflowEngine, engine)),
	};
};
