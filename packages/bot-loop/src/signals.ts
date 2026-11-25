import { Turns } from "@sugabots/core/chats/turns/turns";
import { processLayer } from "@sugabots/core/tiers";
import { Effect, Layer, type Schema } from "effect";
import { DurableDeferred, WorkflowEngine } from "effect/unstable/workflow";
import { approvalDecided, approvalWithdrawn, interruptRequested, Turn } from "./turn.workflow.ts";

/**
 * Core's `TurnSignals`, which tells a turn's workflow execution of members'
 * decisions, of approvals withdrawn and of its interruption, through the
 * deferreds it waits on.
 */
export const make = Effect.gen(function* () {
	const engine = yield* WorkflowEngine.WorkflowEngine;
	const tokenFor = <Success extends Schema.Constraint>(
		deferred: DurableDeferred.DurableDeferred<Success>,
		executionId: string,
	) => DurableDeferred.tokenFromExecutionId(deferred, { workflow: Turn, executionId });
	return Turns.TurnSignals.Service.of({
		decide: (signal) => {
			const decided = approvalDecided(signal.approvalId);
			return DurableDeferred.succeed(decided, {
				token: tokenFor(decided, signal.executionId),
				value: signal.decision,
			}).pipe(Effect.provideService(WorkflowEngine.WorkflowEngine, engine));
		},
		withdraw: (signal) => {
			const withdrawn = approvalWithdrawn(signal.approvalId);
			return DurableDeferred.succeed(withdrawn, {
				token: tokenFor(withdrawn, signal.executionId),
				value: undefined,
			}).pipe(Effect.provideService(WorkflowEngine.WorkflowEngine, engine));
		},
		cancel: (executionId) =>
			DurableDeferred.succeed(interruptRequested, {
				token: tokenFor(interruptRequested, executionId),
				value: undefined,
			}).pipe(Effect.provideService(WorkflowEngine.WorkflowEngine, engine)),
	});
});

export const layer = processLayer(
	Layer.effect(Turns.TurnSignals.Service, Effect.map(make, Turns.TurnSignals.resentOnCommit)),
);
