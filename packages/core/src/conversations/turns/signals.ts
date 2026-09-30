export * as TurnSignals from "./signals.ts";

import { Context, Effect, Layer, type Schema } from "effect";
import { DurableDeferred, WorkflowEngine } from "effect/unstable/workflow";
import type { ApprovalDecision } from "./tool-calls/lifecycle.ts";
import { approvalDecided, cancelRequested, Turn } from "./turn.workflow.ts";

/**
 * What people tell a turn's workflow execution while it waits for approvals.
 * A decision is sent in the transaction that records it (see
 * `Turns.Controls`), and the first sent is the one that stands, so a repeated
 * or late signal changes nothing. `owner` is the turn's execution id.
 */
export interface Interface {
	readonly decide: (signal: {
		readonly owner: string;
		readonly approvalId: string;
		readonly decision: ApprovalDecision;
	}) => Effect.Effect<void>;
	readonly cancel: (owner: string) => Effect.Effect<void>;
}

export class Service extends Context.Service<Service, Interface>()("@sugabots/core/TurnSignals") {}

export const make = Effect.gen(function* () {
	const engine = yield* WorkflowEngine.WorkflowEngine;
	const tokenFor = <Success extends Schema.Constraint>(
		deferred: DurableDeferred.DurableDeferred<Success>,
		executionId: string,
	) => DurableDeferred.tokenFromExecutionId(deferred, { workflow: Turn, executionId });
	return Service.of({
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
	});
});

export const layer = Layer.effect(Service, make);
