/**
 * A bot's turn: one bot answering one message, from being asked until
 * its reply is complete, failed or cancelled. Hidden behind this module are
 * the turn's lifecycle, its records, the reply saved as it arrives, the tools
 * it calls and the approvals members give them. The turn's durable workflow,
 * which runs it step by step, is the bot loop's, in `@sugabots/bot-loop`.
 *
 * Two services for the rest of the system. `Service` acts for no one:
 * asking for a turn, stopping the turns under an automation run, and recording a
 * system bot's work as a turn. `Controls` is for members, and demands proof
 * of what they may do: deciding a turn's tool approvals, steering a turn and
 * interrupting one.
 *
 * For the bot loop: what it records of a turn (`Records`, which the loop's
 * own operations are built from), what its workflow does with no principal
 * (`Runs`), the tools each step offers (`Tools`), and the services core
 * declares and the loop provides, because the loop owns the workflow:
 * starting a turn (`TurnRequests`) and signalling one (`TurnSignals`).
 *
 * This is the only file outside `turns/` may import.
 */
export * as Turns from "./turns.ts";

import type { ToolApprovalDecision } from "@sugabots/contracts";
import type {
	ToolApprovalConflict,
	ToolApprovalNotFound,
} from "@sugabots/contracts/errors/approvals";
import type { ActionForbidden, ResourceHidden } from "@sugabots/contracts/errors/proofs";
import { inArray, type SQLWrapper } from "drizzle-orm";
import { Context, type Effect, Layer } from "effect";
import { ACTIVE_TURN_STATUSES, type TurnSteer, turn } from "../../database/schema.ts";
import type { CanDecide } from "../../proofs/can-decide.ts";
import type { IsMember } from "../../proofs/is-member.ts";
import type { CanInterrupt, CanSteer } from "../../proofs/turn-control.ts";
import { processLayer, Tier } from "../../tiers.ts";
import type { UserFacing } from "../../user-message.ts";
import { laneBusy, waitingSince } from "../../workflows/lanes.ts";
import { makeControls } from "./controls.ts";
import { TURN_WORKFLOW, type TurnRequest } from "./requests.ts";
import { makeService } from "./service.ts";
import { TurnStore } from "./store.ts";
import { ToolCallStore } from "./tool-calls/store.ts";

export {
	ToolApprovalConflict,
	ToolApprovalNotFound,
} from "@sugabots/contracts/errors/approvals";
export { ApprovalWithdrawals, dueApprovals } from "./approval-withdrawals.ts";
export { botsAskedBefore, earliestAnsweredByTurnToCome, handBackOwed } from "./collaboration.ts";
export {
	contextWindowTokens,
	estimatedTokens,
	loadContextWindow,
	MAX_CONTEXT_WINDOW_TOKENS,
	newestWithinLimit,
} from "./context-window.ts";
export type { OpenedTurn, TurnRun } from "./execution.ts";
export {
	executionFence,
	type FenceRefusal,
	holdRunningTurn,
	holdTurnForToolWrite,
	holdTurnOf,
} from "./fence.ts";
export { type Ended, MAX_TURN_RUNS, TURN_CANCELLED } from "./lifecycle.ts";
export { TurnRecords as Records } from "./records.ts";
export { TurnRequests } from "./requests.ts";
export { TurnRuns as Runs } from "./runs.ts";
export { TurnSignals } from "./signals.ts";
export { type NotRunnable, recordJoin } from "./store.ts";
export {
	ApprovalDecision,
	DENIED_OUTPUT,
	DecidedApproval,
} from "./tool-calls/lifecycle.ts";
export { commitWrittenFile, replayWrittenFile } from "./tool-calls/store.ts";
export { TurnTools as Tools } from "./tools.ts";
export { WorkAdmission } from "./work-admission.ts";

/** A system bot's piece of work, recorded as its turn in its own chat. */
interface SystemTurn {
	readonly chatId: string;
	readonly botId: string;
	readonly triggerMessageId: string;
	readonly model: string;
	/** What the work is, as the logs name it, such as "compaction". */
	readonly name: string;
}

/**
 * How recording a system turn went. `Skipped` when its turn may not run, for
 * the reason given, which is for the logs. A failure is recorded on the turn
 * and logged, so the caller has nothing more to do with it.
 */
type SystemTurnOutcome<A> =
	| { readonly _tag: "Completed"; readonly value: A }
	| { readonly _tag: "Failed" }
	| { readonly _tag: "Skipped"; readonly reason: string };

export interface Interface {
	/**
	 * Asks for a bot's turn, in the caller's transaction; it starts once
	 * that commits. It joins a turn of the same bot in the same chat waiting
	 * for the same member, which reads that member's messages posted before it
	 * starts; otherwise it waits behind the turns there (see
	 * `TurnRequests.admission`).
	 */
	readonly ask: (request: TurnRequest) => Effect.Effect<void>;
	/**
	 * Stops the turns in the chats `chatIds`, in the caller's transaction:
	 * cancels those waiting for approvals, tells their workflows once it
	 * commits, and drops the turns still waiting to start. A running turn is
	 * left to finish.
	 */
	readonly stopUnder: (chatIds: readonly string[]) => Effect.Effect<void>;
	/**
	 * Records `work` as a system bot's turn: opens the turn, runs `work` with
	 * its id, and completes it with the prompt size `work` measured, or fails
	 * it with what went wrong. Only `work` may be interrupted; how it ended is
	 * always written.
	 */
	readonly recordSystemTurn: <A, E extends UserFacing, R>(
		turn: SystemTurn,
		work: (turnId: string) => Effect.Effect<{ value: A; contextTokens?: number }, E, R>,
	) => Effect.Effect<SystemTurnOutcome<A>, never, R>;
}

export class Service extends Context.Service<Service, Interface>()("@sugabots/core/Turns") {
	declare readonly [Tier]: "process";
}

/** What members may do to a turn, once proved. */
export interface ControlsInterface {
	/**
	 * Decides the tool call `canDecide` is about, for the member `isMember`
	 * names, its approver. In one transaction, once the call's turn is locked,
	 * it proves again that they may still decide it, records the decision, so
	 * the chat's watchers see it at once, makes the change an allowed call
	 * asks of its approver (`allowed`, given the fresh proof), and sends the
	 * decision to the turn's workflow, which runs what was allowed. A call
	 * that waits for no decision, or whose turn no longer waits, is not found;
	 * one somebody decided first is a conflict.
	 */
	readonly decide: <P, X>(
		isMember: IsMember<P>,
		canDecide: CanDecide<P, X>,
		decision: ToolApprovalDecision["decision"],
		allowed: (canDecide: CanDecide<P, X>) => Effect.Effect<void>,
	) => Effect.Effect<
		void,
		ToolApprovalNotFound | ToolApprovalConflict | ResourceHidden | ActionForbidden
	>;
	/**
	 * Makes `steer.messageId`, the message the turn's asker just posted, which
	 * the floor gave its bot for `steer.reason`, a steer of the turn `canSteer`
	 * is about, once the turn's row is locked: the turn
	 * reads it before its next step, and a turn waiting for approvals has them
	 * withdrawn and is told, so it reads the message next. `false` when the turn
	 * has ended, or is ending, so the message needs a turn of its own.
	 */
	readonly steer: <P, T>(canSteer: CanSteer<P, T>, steer: TurnSteer) => Effect.Effect<boolean>;
	/**
	 * Interrupts the turn `canInterrupt` is about, once its row is locked: ends
	 * the step under way, withdraws any approval it waits for, and ends the
	 * turn. A turn that has ended already is left as it is.
	 */
	readonly interrupt: <P, T>(canInterrupt: CanInterrupt<P, T>) => Effect.Effect<void>;
}

export class Controls extends Context.Service<Controls, ControlsInterface>()(
	"@sugabots/core/Turns/Controls",
) {
	declare readonly [Tier]: "process";
}

const internals = Layer.mergeAll(TurnStore.layer, ToolCallStore.layer);

/**
 * `Service`. Needs the chat services a turn reports to, and the services
 * that start and signal turns, which the bot loop provides.
 */
export const layer = processLayer(Layer.effect(Service, makeService)).pipe(
	Layer.provide(internals),
);

/**
 * `Controls`, which the approvals operations are built from. Needs the chat
 * services a turn reports to, and the services that signal turns.
 */
export const controlsLayer = processLayer(Layer.effect(Controls, makeControls)).pipe(
	Layer.provide(internals),
);

/** Re-sends cancels lost between their commit and their signal (see `resendLostCancels`). */
export { cancelSweepLayer, resendLostCancels } from "./cancel-sweep.ts";

/**
 * busyIn reports, as a condition for a query, whether a bot's turn in the
 * chat `chatId` is running or waiting to start.
 */
export const busyIn = (chatId: SQLWrapper) => laneBusy(chatId, [TURN_WORKFLOW]);

/**
 * When a turn in the chat `chatId` started waiting to start, as a value
 * for a query; null when none waits. It is asked for in the transaction that
 * posts the message asking, so that message has the same time, and the turn
 * reads it and everything posted after it once it starts.
 */
export const queuedSince = (chatId: SQLWrapper) => waitingSince(chatId, TURN_WORKFLOW);

/** isActive reports, as a condition for a query, whether a turn is running or waiting on approvals. */
export const isActive = inArray(turn.status, [...ACTIVE_TURN_STATUSES]);
