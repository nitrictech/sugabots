/**
 * A bot's turn: one bot answering one message, from being asked until
 * its reply is complete, failed or cancelled. Hidden behind this module are
 * the turn's durable workflow, its lifecycle, the reply streamed and saved as
 * it arrives, the tools it calls and the approvals people give them, and the
 * signals that reach a turn while it runs or waits.
 *
 * Two services. `Service` is for the rest of the system and acts for no one:
 * asking for a turn, stopping the turns under an automation run, and recording a
 * system bot's work as a turn. `Controls` is for people, and checks what
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
import { ACTIVE_TURN_STATUSES, turn } from "../../database/schema.ts";
import { ConversationFiles } from "../../files/conversation-files.ts";
import { Files } from "../../files/files.ts";
import type { UserFacing } from "../../user-message.ts";
import { laneBusy, waitingSince } from "../../workflows/lanes.ts";
import { BotRepository } from "../../workspaces/bots/bot-repository.ts";
import { ApprovedToolCalls } from "./approvals/approved-calls.ts";
import {
	makeControls,
	type ToolApprovalConflict,
	type ToolApprovalForbidden,
	type ToolApprovalNotFound,
} from "./controls.ts";
import { TurnExecution } from "./execution.ts";
import { TurnRepository } from "./repository.ts";
import { makeService } from "./service.ts";
import { TurnSignals } from "./signals.ts";
import { ToolCallRepository } from "./tool-calls/repository.ts";
import { turnStepsLayer } from "./turn.steps.ts";
import { Turn, type TurnRequest, turnWorkflow } from "./turn.workflow.ts";

export {
	contextWindowTokens,
	estimatedTokens,
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
export { WorkAdmission } from "./work-admission.ts";

/** A system bot's piece of work, recorded as its turn in its own conversation. */
export interface SystemTurn {
	readonly conversationId: string;
	readonly botId: string;
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
type SystemTurnOutcome<A> =
	| { readonly _tag: "Completed"; readonly value: A }
	| { readonly _tag: "Failed" }
	| { readonly _tag: "Skipped"; readonly reason: string };

export interface Interface {
	/**
	 * Asks for a bot's turn, in the caller's transaction; it starts once
	 * that commits. A turn already asked for, for the same bot in the same
	 * conversation, is kept, because it will read every message posted since.
	 */
	readonly ask: (request: TurnRequest) => Effect.Effect<void>;
	/**
	 * Stops the turns in the conversations `conversationIds`, in the caller's transaction:
	 * cancels those waiting for approvals, tells their workflows once it
	 * commits, and drops the turns still waiting to start. A running turn is
	 * left to finish.
	 */
	readonly stopUnder: (conversationIds: readonly string[]) => Effect.Effect<void>;
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

export class Service extends Context.Service<Service, Interface>()("@sugabots/core/Turns") {}

/** What people may do to a turn, as the current actor. */
export interface ControlsInterface {
	/** Asks a turn in a conversation the actor can see to stop. `false` when it is no longer running. */
	readonly cancel: (turnId: string) => Effect.Effect<boolean, ResourceHidden, CurrentActor.Service>;
	/**
	 * Decides a tool call a turn is waiting on, as the actor, once they may.
	 * The decision is recorded, so the conversation's watchers see it at once, and
	 * sent to the turn's workflow, which runs what was allowed.
	 */
	readonly decide: (input: {
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

/**
 * What the turn workflow's steps do: the rest of a turn's machinery.
 * Suspended: the steps' module reaches this one through the bot threads and
 * the chats, so `turnStepsLayer` is read once the layer is built, not while
 * the modules load.
 */
export const stepsLayer = Layer.suspend(() =>
	turnStepsLayer.pipe(
		Layer.provide(
			Layer.mergeAll(
				TurnExecution.layer,
				ApprovedToolCalls.layer,
				BotRepository.layer,
				ConversationFiles.layer,
				Files.authoringLayer,
			),
		),
		Layer.provide(internals),
	),
);

/**
 * How a turn hears people while it runs or waits, over the workflow engine.
 * Provided with the engine, so a test can stand in for it.
 */
export const signalsLayer = TurnSignals.layer;

/** Re-sends cancels lost between their commit and their signal (see `resendLostCancels`). */
export { cancelSweepLayer, resendLostCancels } from "./cancel-sweep.ts";

/**
 * busyIn reports, as a condition for a query, whether a bot's turn in the
 * conversation `conversationId` is running or waiting to start.
 */
export const busyIn = (conversationId: SQLWrapper) => laneBusy(conversationId, [Turn._tag]);

/**
 * When a turn in the conversation `conversationId` started waiting to start, as a value
 * for a query; null when none waits. It is asked for in the transaction that
 * posts the message asking, so that message has the same time, and the turn
 * reads it and everything posted after it once it starts.
 */
export const queuedSince = (conversationId: SQLWrapper) => waitingSince(conversationId, Turn._tag);

/** isActive reports, as a condition for a query, whether a turn is running or waiting on approvals. */
export const isActive = inArray(turn.status, [...ACTIVE_TURN_STATUSES]);
