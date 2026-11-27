export * as TurnSignals from "./signals.ts";

import { Context, Effect } from "effect";
import { afterCommit } from "../../database/database.ts";
import { Tier } from "../../tiers.ts";
import type { ApprovalDecision } from "./tool-calls/lifecycle.ts";

/**
 * What a turn's workflow execution is told while it waits for approvals:
 * members' decisions, that an approval was withdrawn, and that it was
 * interrupted, as when its automation run ended or a member interrupted it.
 * A decision is sent in the transaction that records it (see
 * `Turns.Controls`), and the first sent is the one that stands, so a repeated
 * or late signal changes nothing. `executionId` is the workflow execution
 * running the turn.
 *
 * The bot loop owns the turn's workflow, so it implements this; core declares
 * it and the server provides it from the bot loop.
 */
export interface Interface {
	readonly decide: (signal: {
		readonly executionId: string;
		readonly approvalId: string;
		readonly decision: ApprovalDecision;
	}) => Effect.Effect<void>;
	readonly cancel: (executionId: string) => Effect.Effect<void>;
	/**
	 * Tells the execution `executionId` that the approval `approvalId` it waits
	 * for was withdrawn, as a steer withdraws it, so it stops waiting for it.
	 */
	readonly withdraw: (signal: {
		readonly executionId: string;
		readonly approvalId: string;
	}) => Effect.Effect<void>;
}

export class Service extends Context.Service<Service, Interface>()("@sugabots/core/TurnSignals") {
	declare readonly [Tier]: "process";
}

/**
 * `signals`, each sent in the caller's transaction, so it commits with what it
 * tells, and sent again once that commits: the workflow engine looks for a
 * signal as it is written, and missing it there, as it does when the
 * transaction goes on after it, waits for its next poll, seconds later. The
 * first sent stands, so the second changes nothing else.
 */
export const resentOnCommit = (signals: Interface): Interface => ({
	decide: (signal) => sentTwice(signals.decide(signal)),
	withdraw: (signal) => sentTwice(signals.withdraw(signal)),
	cancel: (executionId) => sentTwice(signals.cancel(executionId)),
});

const sentTwice = (send: Effect.Effect<void>) => Effect.andThen(send, afterCommit(send));
