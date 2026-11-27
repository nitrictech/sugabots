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
 * For the bot loop: what it records of a turn (`Records`, which
 * `RunningTurn` is built from), what its workflow does with no principal
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
import type { DomainError, UserText } from "@sugabots/errors";
import { inArray, type SQLWrapper } from "drizzle-orm";
import { Cause, Context, Effect, Exit, Layer, Option } from "effect";
import { afterCommit, serviceOperations, transaction } from "../../database/database.ts";
import {
	ACTIVE_TURN_STATUSES,
	type TurnSteer,
	type toolCall,
	turn,
} from "../../database/schema.ts";
import { Ids } from "../../ids/ids.ts";
import type { CanDecide } from "../../proofs/can-decide.ts";
import type { IsMember } from "../../proofs/is-member.ts";
import type { CanInterrupt, CanSteer } from "../../proofs/turn-control.ts";
import { processLayer, Tier } from "../../tiers.ts";
import { Lanes, laneBusy, waitingSince } from "../../workflows/lanes.ts";
import { makeControls } from "./controls.ts";
import { logTurnDefect, SYSTEM_TURN_INTERRUPTED } from "./lifecycle.ts";
import { TURN_WORKFLOW, type TurnRequest } from "./requests.ts";
import { TurnSignals } from "./signals.ts";
import { TurnStore } from "./store.ts";
import { ToolCallStore } from "./tool-calls/store.ts";

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
	readonly recordSystemTurn: <A, E extends DomainError, R>(
		turn: SystemTurn,
		work: (turnId: string) => Effect.Effect<{ value: A; contextTokens?: number }, E, R>,
	) => Effect.Effect<SystemTurnOutcome<A>, never, R>;
}

export class Service extends Context.Service<Service, Interface>()("@sugabots/core/Turns") {
	declare readonly [Tier]: "process";
}

/**
 * `Service`, over the turns' records, the lanes turns wait in and the
 * service that signals turns, which the bot loop provides.
 */
export const make = Effect.gen(function* () {
	const operation = yield* serviceOperations<Interface>("Turns");
	const ids = yield* Ids.Service;
	const lanes = yield* Lanes.Service;
	const turns = yield* TurnStore.Service;
	const signals = yield* TurnSignals.Service;

	const recordSystemTurn: Interface["recordSystemTurn"] = (systemTurn, work) =>
		Effect.gen(function* () {
			const opened = yield* turns.openSystemBotTurn(systemTurn);
			if (opened._tag === "NotRunnable") {
				return { _tag: "Skipped", reason: opened.reason } as const;
			}
			return yield* Effect.uninterruptibleMask((restore) =>
				Effect.gen(function* () {
					const worked = yield* Effect.exit(restore(work(opened.turnId)));
					if (Exit.isSuccess(worked)) {
						yield* turns.completeSystemBotTurn(opened.turnId, worked.value.contextTokens);
						return { _tag: "Completed", value: worked.value.value } as const;
					}
					const expected = Cause.findErrorOption(worked.cause);
					const interrupted = Cause.hasInterruptsOnly(worked.cause);
					let userMessage: UserText;
					if (Option.isSome(expected) && !Cause.hasDies(worked.cause)) {
						yield* Effect.logWarning(`A ${systemTurn.name} failed: ${expected.value.message}`);
						userMessage = expected.value.userMessage;
					} else if (interrupted) {
						yield* Effect.logError(`A ${systemTurn.name} did not finish`, worked.cause);
						userMessage = SYSTEM_TURN_INTERRUPTED;
					} else {
						userMessage = yield* logTurnDefect(
							yield* ids.random,
							`A ${systemTurn.name} did not finish`,
							worked.cause,
						);
					}
					yield* turns.failSystemBotTurn(opened.turnId, userMessage);
					return { _tag: "Failed" } as const;
				}),
			);
		});

	return {
		ask: (request) => operation("ask", turns.ask(request)),
		stopUnder: (chatIds) =>
			operation(
				"stopUnder",
				transaction(
					Effect.gen(function* () {
						if (chatIds.length === 0) return;
						// Workflows waiting on approvals or a retry still hold their lanes
						// until they hear that their turns were cancelled.
						const stillWaiting = yield* turns.cancelUnder(chatIds);
						yield* afterCommit(
							Effect.forEach(stillWaiting, (executionId) => signals.cancel(executionId), {
								discard: true,
							}),
						);
						yield* lanes.dropWaiting(chatIds, [TURN_WORKFLOW]);
					}),
				),
			),
		recordSystemTurn: (systemTurn, work) =>
			operation("recordSystemTurn", recordSystemTurn(systemTurn, work)),
	} satisfies Interface;
});

export const layerNoDeps = processLayer(Layer.effect(Service, make));

/**
 * `Service`. Needs the chat services a turn reports to, and the services
 * that start and signal turns, which the bot loop provides.
 */
export const layer = layerNoDeps.pipe(Layer.provide(TurnStore.layer));

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
export {
	type Ended,
	logTurnDefect,
	MAX_TURN_RUNS,
	TURN_CANCELLED,
	turnStoppedUnexpectedly,
} from "./lifecycle.ts";
export type {
	ApprovalAsked,
	CallPlan,
	RequestedCall,
	StepCall,
	ToolResultOutput,
} from "./loop-values.ts";
export { TurnRecords as Records } from "./records.ts";
export { TurnRequests } from "./requests.ts";
export { TurnRuns as Runs } from "./runs.ts";
export { TurnSignals } from "./signals.ts";
export type { NotRunnable } from "./store.ts";
export { recordTurnProjectGrant } from "./store.ts";
export {
	ApprovalDecision,
	DENIED_OUTPUT,
	DecidedApproval,
} from "./tool-calls/lifecycle.ts";
export { readCurrentApproval } from "./tool-calls/pending-approval.ts";
export { commitWrittenFile, inputShownInFull, replayWrittenFile } from "./tool-calls/store.ts";
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

export type ApprovalCall = Pick<
	typeof toolCall.$inferSelect,
	| "tool"
	| "turnId"
	| "input"
	| "executionInput"
	| "connectorId"
	| "connectorRevision"
	| "remoteToolName"
	| "approvalConnectorAccess"
	| "approvalResolvedTargets"
	| "writeOrDelete"
>;

/** What members may do to a turn, once proved. */
export interface ControlsInterface {
	/**
	 * Decides the approval `approvalId` of the tool call `canDecide` is about,
	 * for the member `isMember` names, its approver. In one transaction, once
	 * the call's turn is locked, it checks the pending approval. On Allow,
	 * `allow` checks the approver's permission for the recorded call and makes
	 * any change the approval itself grants before the decision is recorded
	 * and signalled. If `allow` returns an invalidation reason, the approval
	 * is closed and the turn wakes before the conflict is returned. An
	 * approval that is no longer current is not found.
	 * An approval that already has a decision is a conflict.
	 */
	readonly decide: <P, X, R>(
		isMember: IsMember<P>,
		canDecide: CanDecide<P, X>,
		approvalId: string,
		decision: ToolApprovalDecision["decision"],
		allow: (
			canDecide: CanDecide<P, X>,
			call: ApprovalCall,
			executionNumber: number,
		) => Effect.Effect<ToolApprovalConflict["reason"], ActionForbidden, R>,
	) => Effect.Effect<
		void,
		ToolApprovalNotFound | ToolApprovalConflict | ResourceHidden | ActionForbidden,
		R
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

/**
 * `Controls`, which the approvals operations are built from. Needs the chat
 * services a turn reports to, and the services that signal turns.
 */
export const controlsLayer = processLayer(Layer.effect(Controls, makeControls)).pipe(
	Layer.provide(Layer.mergeAll(TurnStore.layer, ToolCallStore.layer)),
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
