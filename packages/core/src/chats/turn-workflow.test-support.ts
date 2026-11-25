/**
 * Stand-ins for the bot loop's turn workflow, for core's cases, which may not
 * import `@sugabots/bot-loop`. Kept apart from `testing.ts` and
 * `turns/testing.ts`, which import each other, so these are defined
 * whichever of the two loads first.
 */

import { Effect, Layer, type Schema } from "effect";
import { DurableDeferred, Workflow, WorkflowEngine } from "effect/unstable/workflow";
import { Lanes } from "../workflows/lanes.ts";
import { Turns } from "./turns/turns.ts";

const { TurnRequests, TurnSignals } = Turns;
const { executionKey, TURN_WORKFLOW, TurnRequest } = TurnRequests;

/**
 * The turn workflow as core's cases know it: the bot loop's has the same
 * name, payload and idempotency key, so its executions have the same ids.
 * The engine the cases run on holds each execution's lane until a case frees
 * it (see `testing.ts`).
 */
export const turnWorkflowForTests = Workflow.make(TURN_WORKFLOW, {
	payload: TurnRequest,
	idempotencyKey: executionKey,
});

/** A member's decision on one approval, as the bot loop's workflow waits on it. */
export const approvalDecidedForTests = (approvalId: string) =>
	DurableDeferred.make(`approval/${approvalId}`, { success: Turns.ApprovalDecision });

/** A cancel, as the bot loop's workflow waits on it. */
export const interruptedForTests = DurableDeferred.make("interrupted");

/** The bot loop's `approvalWithdrawn`, by the same name. */
export const approvalWithdrawnForTests = (approvalId: string) =>
	DurableDeferred.make(`approval/${approvalId}/withdrawn`);

/** `TurnRequests` as the bot loop provides it, over the cases' lanes and the stand-in workflow. */
export const turnRequestsForTests = Layer.effect(
	TurnRequests.Service,
	Effect.map(Lanes.Service, (lanes) =>
		TurnRequests.Service.of({
			ask: (request) =>
				lanes.admit({
					...TurnRequests.admission(request),
					workflow: turnWorkflowForTests,
					payload: request,
				}),
		}),
	),
);

/** `TurnSignals` as the bot loop provides it, signalling the stand-in workflow's executions. */
export const turnSignalsForTests = Layer.effect(
	TurnSignals.Service,
	Effect.map(WorkflowEngine.WorkflowEngine, (engine) => {
		const tokenFor = <Success extends Schema.Constraint>(
			deferred: DurableDeferred.DurableDeferred<Success>,
			executionId: string,
		) =>
			DurableDeferred.tokenFromExecutionId(deferred, {
				workflow: turnWorkflowForTests,
				executionId,
			});
		return TurnSignals.Service.of({
			decide: (signal) => {
				const decided = approvalDecidedForTests(signal.approvalId);
				return DurableDeferred.succeed(decided, {
					token: tokenFor(decided, signal.executionId),
					value: signal.decision,
				}).pipe(Effect.provideService(WorkflowEngine.WorkflowEngine, engine));
			},
			withdraw: (signal) => {
				const withdrawn = approvalWithdrawnForTests(signal.approvalId);
				return DurableDeferred.succeed(withdrawn, {
					token: tokenFor(withdrawn, signal.executionId),
					value: undefined,
				}).pipe(Effect.provideService(WorkflowEngine.WorkflowEngine, engine));
			},
			cancel: (executionId) =>
				DurableDeferred.succeed(interruptedForTests, {
					token: tokenFor(interruptedForTests, executionId),
					value: undefined,
				}).pipe(Effect.provideService(WorkflowEngine.WorkflowEngine, engine)),
		});
	}),
);
