/**
 * A bot's turn, as a durable workflow: its definition and the order of its
 * steps. What each step does lives behind `TurnSteps`, implemented in
 * `steps.ts`.
 *
 * A turn runs in steps: each one model request and the tool calls it makes.
 * Each time the turn starts or resumes, in whatever process, this code
 * authenticates its principal afresh from the turn's id, in the workflow
 * itself rather than in an activity, whose journaled result would be
 * replayed instead of checked. A step that asks for approvals leaves the turn
 * waiting, durably, until members decide them; the next step runs what they
 * allowed.
 */

import { TurnAuthentication } from "@sugabots/core/authentication/turn";
import { Turns } from "@sugabots/core/chats/turns/turns";
import type { BotPrincipal } from "@sugabots/core/principal";
import { Tier } from "@sugabots/core/tiers";
import { Lanes } from "@sugabots/core/workflows/lanes";
import { Activities } from "@sugabots/workflow/activities";
import { Cause, Context, Duration, Effect, Exit, Schema } from "effect";
import {
	Activity,
	DurableClock,
	DurableDeferred,
	Workflow,
	WorkflowEngine,
} from "effect/unstable/workflow";

const { TurnRequest, TURN_WORKFLOW, executionKey, turnLane } = Turns.TurnRequests;
type TurnRequest = Turns.TurnRequests.TurnRequest;

/** A turn is one bot answering one message, so that is what identifies its execution. */
export const Turn = Workflow.make(TURN_WORKFLOW, {
	payload: TurnRequest,
	idempotencyKey: executionKey,
});

/** How opening the turn for a run went: opened, with its id, or it may not run. */
export const Opening = Schema.Union([
	Schema.TaggedStruct("Opened", { turnId: Schema.String }),
	Schema.TaggedStruct("NotRunnable", {}),
]);
export type Opening = typeof Opening.Type;

/**
 * How a step ended: the turn goes on to its next step, it is over, it waits
 * for approvals, or it failed and is recorded as a turn that runs again.
 */
export const StepOutcome = Schema.Union([
	Schema.TaggedStruct("Continue", {}),
	Schema.TaggedStruct("Finished", {}),
	Schema.TaggedStruct("Waiting", {
		/** The approvals the turn waits for, each decided through `approvalDecided`. */
		approvals: Schema.Array(Schema.String),
		/**
		 * Whether the step was taken, its calls waiting for approval; if not, the
		 * turn was found still waiting, and the same step is taken once it stops.
		 */
		taken: Schema.Boolean,
	}),
	Schema.TaggedStruct("Retry", {
		/** How long the provider asked to be left, when it said; the turn waits at least `RETRY_DELAY`. */
		after: Schema.optional(Schema.DurationFromMillis),
	}).pipe(Schema.encodeKeys({ after: "afterMillis" })),
]);
export type StepOutcome = typeof StepOutcome.Type;

/**
 * What taking a step came to: how it ended, or that a newer execution of the
 * turn took it over, which ends this execution without journaling anything.
 */
export type StepResult = StepOutcome | { readonly _tag: "Superseded" };

/**
 * A member's decision on one approval. It is sent in the transaction that
 * records it (see `Turns.Controls`), so the two commit or roll back together.
 */
export const approvalDecided = (approvalId: string) =>
	DurableDeferred.make(`approval/${approvalId}`, { success: Turns.ApprovalDecision });

/**
 * An approval the turn waits for was withdrawn, as when its asker steered it,
 * so it stops waiting for it and reads what became of its call.
 */
export const approvalWithdrawn = (approvalId: string) =>
	DurableDeferred.make(`approval/${approvalId}/withdrawn`);

/** The turn was cancelled while it waited for approvals or a retry. */
export const interruptRequested = DurableDeferred.make("interrupted");

/** Where a step is in its turn: the turn, which run of it, and which step. */
export interface StepPlace {
	readonly turnId: string;
	/** Which run of the turn: 0, then one more each time a failed turn runs again. */
	readonly attempt: number;
	/** Which step of the run, counted from 0: its `step`th model request. */
	readonly step: number;
}

export class TurnSteps extends Context.Service<
	TurnSteps,
	{
		/** Opens the turn for its run `attempt`: its id, or that it may not run. */
		readonly open: (turn: TurnRequest, attempt: number) => Effect.Effect<Opening>;
		/** Takes one step of the turn, for its principal, and says how it ended. */
		readonly step: (
			turn: TurnRequest,
			principal: BotPrincipal,
			place: StepPlace,
		) => Effect.Effect<StepResult>;
		readonly release: (execution: {
			readonly turn: string;
			readonly executionNumber?: number;
		}) => Effect.Effect<void>;
		/** Ends the turn its workflow heard was cancelled while it waited. */
		readonly cancelled: (principal: BotPrincipal, turnId: string) => Effect.Effect<void>;
		/**
		 * Ends the turn as failed for the execution whose step died, unless a
		 * newer execution took the turn over.
		 */
		readonly died: (principal: BotPrincipal, turnId: string) => Effect.Effect<StepResult>;
		/** Ends the turn of run `attempt`, which has nobody to act for, as failed. */
		readonly unauthenticated: (turn: TurnRequest, attempt: number) => Effect.Effect<void>;
		/** Ends the turn as failed when its workflow fails. */
		readonly abandon: (turn: TurnRequest) => Effect.Effect<void>;
		/**
		 * Announces that the turn's lane is free. An automation run cannot settle
		 * while any of its lanes is busy, so this may let it.
		 */
		readonly announceReleased: (turn: TurnRequest) => Effect.Effect<void>;
	}
>()("@sugabots/bot-loop/TurnSteps") {
	declare readonly [Tier]: "process";
}

/** The activities that need only the turn's request, each one run once per input. */
const turnActivities = Activities.fromService<TurnRequest>()(TurnSteps, {
	open: { input: Schema.Int, success: Opening },
	unauthenticated: { input: Schema.Int },
	abandon: {},
	announceReleased: {},
});

/**
 * Step `place.step` of run `place.attempt` of the turn, for `principal`, the
 * `round`th time it is taken. The principal is never journaled: each
 * execution authenticates its own.
 *
 * A step a newer execution took over ends this execution: it suspends
 * rather than complete, so the step has no result in the journal, and the
 * execution that took over takes the step itself.
 */
const stepActivity = (
	request: TurnRequest,
	principal: BotPrincipal,
	place: StepPlace,
	round: number,
) =>
	Activity.make({
		name: `step/${place.attempt}/${place.step}/${round}`,
		success: StepOutcome,
		execute: Effect.flatMap(TurnSteps, (steps) => steps.step(request, principal, place)).pipe(
			Effect.flatMap((result) =>
				result._tag === "Superseded"
					? endSuperseded(place.turnId, `step ${place.step}`)
					: Effect.succeed(result),
			),
		),
	});

/** Ends this execution of the turn, which a newer one took over at `at`, without a result. */
const endSuperseded = (turnId: string, at: string) =>
	Effect.logInfo(`Turn ${turnId} carries on in a newer execution; this one stops at ${at}`).pipe(
		Effect.andThen(WorkflowEngine.WorkflowInstance),
		Effect.flatMap((instance) => Workflow.suspend(instance)),
	);

/** Ends the turn its workflow heard was cancelled while it waited after step `step`. */
const cancelledActivity = (
	principal: BotPrincipal,
	turnId: string,
	attempt: number,
	step: number,
) =>
	Activity.make({
		name: `cancelled/${attempt}/${step}`,
		execute: Effect.flatMap(TurnSteps, (steps) => steps.cancelled(principal, turnId)),
	});

/**
 * Ends the turn whose step died in run `attempt`, as the execution that
 * authenticated `principal`; one a newer execution took over ends this
 * execution without a result.
 */
const diedActivity = (principal: BotPrincipal, turnId: string, attempt: number) =>
	Activity.make({
		name: `died/${attempt}`,
		execute: Effect.flatMap(TurnSteps, (steps) => steps.died(principal, turnId)).pipe(
			Effect.flatMap((result) =>
				result._tag === "Superseded" ? endSuperseded(turnId, "its step that died") : Effect.void,
			),
		),
	});

/** How long a turn waits after a failed step before running again. */
const RETRY_DELAY = Duration.seconds(2);

export const turnWorkflow = Lanes.workflow(Turn, {
	lane: turnLane,
	activities: turnActivities,
	body: (request) =>
		Effect.gen(function* () {
			const authentication = yield* TurnAuthentication.Service;
			for (let attempt = 0; ; attempt++) {
				const opened = yield* turnActivities.activity("open", request, attempt);
				if (opened._tag === "NotRunnable") return;
				// Every time the turn starts or resumes, this runs again, so each
				// execution acts only for the principal it authenticated itself.
				const authenticated = yield* Effect.exit(authentication.authenticate(opened.turnId));
				const steps = yield* TurnSteps;
				if (Exit.isFailure(authenticated)) {
					yield* steps.release({ turn: opened.turnId });
					return yield* turnActivities.activity("unauthenticated", request, attempt);
				}
				const principal = authenticated.value;
				const instance = yield* WorkflowEngine.WorkflowInstance;
				const ran = yield* Effect.exit(
					runSteps(request, principal, opened.turnId, attempt).pipe(
						Effect.ensuring(
							Effect.suspend(() => (instance.suspended ? Effect.void : steps.release(principal))),
						),
					),
				);
				// A step that died ends the turn as this execution, which is fenced like
				// its other writes: one a newer execution took over ends nothing. A
				// suspension, or an interruption, isn't a death.
				if (Exit.isFailure(ran)) {
					if (Cause.hasInterruptsOnly(ran.cause)) return yield* Effect.failCause(ran.cause);
					yield* Effect.logError(`A step of turn ${opened.turnId} died`, ran.cause);
					return yield* diedActivity(principal, opened.turnId, attempt);
				}
				const after = ran.value;
				if (after === undefined) return;
				const interrupted = yield* DurableDeferred.raceAll({
					name: `retry-or-interrupt/${attempt}`,
					success: Schema.Boolean,
					error: Schema.Never,
					effects: [
						Effect.as(DurableDeferred.await(interruptRequested), true),
						Effect.as(
							DurableClock.sleep({
								name: `retry/${attempt}`,
								duration: Duration.max(RETRY_DELAY, after),
							}),
							false,
						),
					],
				});
				if (interrupted) return;
			}
		}),
	onFailure: "abandon",
	onReleased: "announceReleased",
});

/**
 * Takes the run's steps until the turn ends, waiting for approvals where a
 * step asks for them. Returns how long to wait before the turn runs again,
 * or undefined once it is over.
 */
const runSteps = (request: TurnRequest, principal: BotPrincipal, turnId: string, attempt: number) =>
	Effect.gen(function* () {
		let round = 0;
		for (let step = 0; ; ) {
			const place = { turnId, attempt, step };
			const outcome = yield* stepActivity(request, principal, place, round);
			switch (outcome._tag) {
				case "Finished":
					return undefined;
				case "Retry":
					return outcome.after ?? Duration.zero;
				case "Continue":
					step++;
					round = 0;
					continue;
				case "Waiting": {
					const name = `${attempt}/${step}/${round}`;
					yield* Effect.flatMap(TurnSteps, (steps) => steps.release(principal));
					yield* releaseForApproval(request, name);
					const cancelled =
						(yield* waitForApprovals(name, outcome.approvals)) ||
						(yield* reacquireAfterApproval(request, name));
					if (cancelled) {
						yield* cancelledActivity(principal, turnId, attempt, step);
						return undefined;
					}
					if (outcome.taken) {
						step++;
						round = 0;
					} else {
						round++;
					}
				}
			}
		}
	});

const releaseForApproval = (request: TurnRequest, name: string) =>
	Activity.make({
		name: `releaseForApproval/${name}`,
		execute: Effect.gen(function* () {
			const lanes = yield* Lanes.Service;
			yield* lanes.release({
				key: turnLane(request),
				executionId: yield* Turn.executionId(request),
			});
		}),
	});

const reacquireAfterApproval = (request: TurnRequest, round: string) =>
	Effect.gen(function* () {
		const held = yield* Activity.make({
			name: `requestLane/${round}`,
			success: Schema.Boolean,
			execute: Effect.gen(function* () {
				const lanes = yield* Lanes.Service;
				return (
					(yield* lanes.admit({
						key: turnLane(request),
						subject: request.chatId,
						workflow: Turn,
						payload: request,
						whenBusy: "resume",
						resumeRound: round,
					})) === "started"
				);
			}),
		});
		if (held) return false;
		return yield* DurableDeferred.raceAll({
			name: `lane-or-interrupt/${round}`,
			success: Schema.Boolean,
			error: Schema.Never,
			effects: [
				Effect.as(DurableDeferred.await(interruptRequested), true),
				Effect.as(DurableDeferred.await(Lanes.laneGranted(round)), false),
			],
		});
	});

const Awaited = Schema.Union([
	Schema.Literal("cancelled"),
	Turns.DecidedApproval,
	Schema.Struct({ withdrawn: Schema.String }),
]);

/**
 * Waits for every approval still outstanding (or a cancel), in whatever order
 * members decide or withdraw them, by racing them. The race's winner is
 * stored, so a replay takes the same path. Returns whether the turn was
 * cancelled instead.
 */
const waitForApprovals = (name: string, approvals: ReadonlyArray<string>) =>
	Effect.gen(function* () {
		let outstanding = approvals;
		for (let round = 0; outstanding.length > 0; round++) {
			const next = yield* DurableDeferred.raceAll({
				name: `approvals/${name}/${round}`,
				success: Awaited,
				error: Schema.Never,
				effects: [
					Effect.as(DurableDeferred.await(interruptRequested), "cancelled" as const),
					...outstanding.map((approvalId) =>
						Effect.map(DurableDeferred.await(approvalDecided(approvalId)), (decision) => ({
							approvalId,
							decision,
						})),
					),
					...outstanding.map((approvalId) =>
						Effect.as(DurableDeferred.await(approvalWithdrawn(approvalId)), {
							withdrawn: approvalId,
						}),
					),
				],
			});
			if (next === "cancelled") return true;
			const settled = "withdrawn" in next ? next.withdrawn : next.approvalId;
			outstanding = outstanding.filter((approvalId) => approvalId !== settled);
		}
		return false;
	});
