/**
 * An agent's turn: one agent answering one message, from being asked until
 * its reply is complete, failed or cancelled. Hidden behind this module are
 * the turn's durable workflow, its lifecycle, the reply streamed and saved as
 * it arrives, the tools it calls and the approvals people give them, and the
 * signals that reach a turn while it runs or waits.
 *
 * Two services. `Service` is for the rest of the system and acts for no one:
 * asking for a turn, stopping the turns under a routine run, and recording a
 * system agent's work as a turn. `Controls` is for people, and checks what
 * the current actor may do: cancelling a turn and deciding its tool approvals.
 *
 * This is the only file outside `turns/` may import.
 */
export * as Turns from "./turns.ts";

import type { ToolApprovalDecision } from "@sugabots/contracts";
import { inArray, type SQLWrapper } from "drizzle-orm";
import { Context, type Effect, Layer } from "effect";
import type { AuthorizationDenied, ResourceHidden } from "../../authorization/access.ts";
import { Authorization } from "../../authorization/authorization.ts";
import type { CurrentActor } from "../../authorization/current-actor.ts";
import { Visibility } from "../../authorization/visibility.ts";
import { turn } from "../../database/schema.ts";
import type { UserFacing } from "../../user-message.ts";
import { laneBusy } from "../../workflows/lanes.ts";
import { ApprovedToolCalls } from "./approvals/approved-calls.ts";
import {
	makeControls,
	type ToolApprovalConflict,
	type ToolApprovalForbidden,
	type ToolApprovalNotFound,
} from "./controls.ts";
import { TurnExecution } from "./execution.ts";
import { ACTIVE_STATUSES } from "./lifecycle.ts";
import { TurnRepository } from "./repository.ts";
import { makeService } from "./service.ts";
import { TurnSignals } from "./signals.ts";
import { ToolCallRepository } from "./tool-calls/repository.ts";
import { turnStepsLayer } from "./turn.steps.ts";
import { Turn, type TurnRequest, turnWorkflow } from "./turn.workflow.ts";

export {
	contextWindowTokens,
	estimatedTokens,
	historyLimitTokens,
	loadContextWindow,
	MAX_CONTEXT_WINDOW_TOKENS,
	newestWithinLimit,
} from "./context-window.ts";
export {
	ToolApprovalConflict,
	ToolApprovalForbidden,
	ToolApprovalNotFound,
} from "./controls.ts";
export type { Ended } from "./lifecycle.ts";

/** Which agent answers which message in which thread, and why it was asked. */
export type Request = TurnRequest;

/** A system agent's piece of work, recorded as its turn in its own thread. */
export interface SystemTurn {
	readonly threadId: string;
	readonly agentId: string;
	readonly triggerMessageId: string;
	readonly model: string;
	/** What the work is, as the logs name it: "summary", "compaction". */
	readonly name: string;
}

/**
 * How recording a system turn went. `Skipped` when its turn may not run, for
 * the reason given, which is for the logs. A failure is recorded on the turn
 * and logged, so the caller has nothing more to do with it.
 */
export type SystemTurnOutcome<A> =
	| { readonly _tag: "Completed"; readonly value: A }
	| { readonly _tag: "Failed" }
	| { readonly _tag: "Skipped"; readonly reason: string };

export interface Interface {
	/**
	 * Asks for an agent's turn, in the caller's transaction; it starts once
	 * that commits. A turn already asked for, for the same agent in the same
	 * thread, is kept, because it will read every message posted since.
	 */
	readonly ask: (request: Request) => Effect.Effect<void>;
	/**
	 * Stops the turns in the threads `threadIds`, in the caller's transaction:
	 * cancels those waiting for approvals, tells their workflows once it
	 * commits, and drops the turns still waiting to start. A running turn is
	 * left to finish.
	 */
	readonly stopUnder: (threadIds: readonly string[]) => Effect.Effect<void>;
	/**
	 * Records `work` as a system agent's turn: opens the turn, runs `work` with
	 * its id, and completes it with the prompt size `work` measured, or fails
	 * it with what went wrong. Only `work` may be interrupted; how it ended is
	 * always written.
	 */
	readonly recordSystemTurn: <A, E extends UserFacing, R>(
		turn: SystemTurn,
		work: (turnId: string) => Effect.Effect<{ value: A; contextTokens?: number }, E, R>,
	) => Effect.Effect<SystemTurnOutcome<A>, never, R>;
}

export class Service extends Context.Service<Service, Interface>()("@sugabots/core/Turns") {}

/** What people may do to a turn, as the current actor. */
export interface ControlsInterface {
	/** Asks a turn in a thread the actor can see to stop. `false` when it is no longer running. */
	readonly cancel: (turnId: string) => Effect.Effect<boolean, ResourceHidden, CurrentActor.Service>;
	/**
	 * Decides a tool call a turn is waiting on, as the actor, once they may.
	 * The decision is recorded, so the thread's watchers see it at once, and
	 * sent to the turn's workflow, which runs what was allowed.
	 */
	readonly decide: (input: {
		podId: string;
		toolCallId: string;
		decision: ToolApprovalDecision["decision"];
	}) => Effect.Effect<
		void,
		AuthorizationDenied | ToolApprovalNotFound | ToolApprovalConflict | ToolApprovalForbidden,
		CurrentActor.Service
	>;
}

export class Controls extends Context.Service<Controls, ControlsInterface>()(
	"@sugabots/core/Turns/Controls",
) {}

const internals = Layer.mergeAll(TurnRepository.layer, ToolCallRepository.layer);

/**
 * Both services. Needs the conversation services a turn reports to, and
 * {@link signalsLayer} over the workflow engine.
 */
export const layer = Layer.mergeAll(
	Layer.effect(Service, makeService),
	Layer.effect(Controls, makeControls).pipe(Layer.provide([Authorization.layer, Visibility.layer])),
).pipe(Layer.provide(internals));

/** The turn's durable workflow, for the engine to run over {@link stepsLayer}. */
export const workflow = turnWorkflow;

/** What the turn workflow's steps do: the rest of a turn's machinery. */
export const stepsLayer = turnStepsLayer.pipe(
	Layer.provide(Layer.mergeAll(TurnExecution.layer, ApprovedToolCalls.layer)),
	Layer.provide(internals),
);

/**
 * How a turn hears people while it runs or waits, over the workflow engine.
 * Provided with the engine, so a test can stand in for it.
 */
export const signalsLayer = TurnSignals.layer;

/**
 * busyIn reports, as a condition for a query, whether an agent's turn in the
 * thread `threadId` is running or waiting to start.
 */
export const busyIn = (threadId: SQLWrapper) => laneBusy(threadId, [Turn._tag]);

/** isActive reports, as a condition for a query, whether a turn is running or waiting on approvals. */
export const isActive = inArray(turn.status, [...ACTIVE_STATUSES]);
