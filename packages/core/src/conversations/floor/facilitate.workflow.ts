/**
 * Facilitating a thread, as a durable workflow: deciding who speaks after a
 * message. It holds the definition and the order of its steps; what
 * each step does lives behind `FacilitateSteps`, implemented in
 * `facilitator.ts`.
 */
import { userText } from "@sugabots/errors";
import { Activities } from "@sugabots/workflow/activities";
import { Context, Data, Duration, Effect, Schema } from "effect";
import { DurableClock, Workflow } from "effect/unstable/workflow";
import type { UserFacing } from "../../user-message.ts";
import { Lanes } from "../../workflows/lanes.ts";

export const FacilitateRequest = Schema.Struct({
	threadId: Schema.String,
	/** The message the facilitator decides the next speaker after. */
	triggerMessageId: Schema.String,
});
export type FacilitateRequest = typeof FacilitateRequest.Type;

export const Facilitate = Workflow.make("facilitate", {
	payload: FacilitateRequest,
	idempotencyKey: (request) => `${request.threadId}/${request.triggerMessageId}`,
});

/** One facilitation per thread at a time; a newer request replaces one still waiting. */
export const facilitateLane = (request: Pick<FacilitateRequest, "threadId">) =>
	`facilitate:${request.threadId}`;

/**
 * Asks the Facilitator who speaks after a message, joining the caller's
 * transaction. A request for a newer message replaces one still waiting,
 * since only the latest message needs a speaker.
 */
export const admitFacilitation = (lanes: Lanes.Interface, request: FacilitateRequest) =>
	lanes
		.admit({
			key: facilitateLane(request),
			subject: request.threadId,
			workflow: Facilitate,
			payload: request,
			whenBusy: "replace",
		})
		.pipe(Effect.asVoid);

/** How an attempt ended: the floor is decided and given, or the attempt failed and changed nothing. */
export const AttemptOutcome = Schema.Literals(["decided", "failed"]);
export type AttemptOutcome = typeof AttemptOutcome.Type;

export class FacilitateSteps extends Context.Service<
	FacilitateSteps,
	{
		/** Decides who speaks next and gives them the floor. `attempt` numbers the attempts from 1. */
		readonly attempt: (
			request: FacilitateRequest,
			attempt: number,
		) => Effect.Effect<AttemptOutcome>;
		/** Announces that facilitation failed, when every attempt did or the workflow failed. */
		readonly abandon: (request: FacilitateRequest) => Effect.Effect<void>;
		/**
		 * Announces that the thread's facilitation lane is free. A routine run
		 * cannot settle while any of its lanes is busy, so this may let it.
		 */
		readonly announceReleased: (request: FacilitateRequest) => Effect.Effect<void>;
	}
>()("@sugabots/core/FacilitateSteps") {}

const facilitateActivities = Activities.fromService<FacilitateRequest>()(FacilitateSteps, {
	attempt: { input: Schema.Int, success: AttemptOutcome },
	abandon: {},
	announceReleased: {},
});

/** Attempts at deciding the floor before facilitation fails. */
const MAX_ATTEMPTS = 3;
/** How long to wait after a failed attempt before the next. */
const RETRY_DELAY = Duration.seconds(1);

/** Every attempt at deciding the floor failed. */
export class FacilitationFailed
	extends Data.TaggedError("FacilitationFailed")
	implements UserFacing
{
	override get message() {
		return `Facilitation failed ${MAX_ATTEMPTS} times`;
	}
	get userMessage() {
		return userText`The Facilitator could not choose who speaks next`;
	}
}

export const facilitateWorkflow = Lanes.workflow(Facilitate, {
	lane: facilitateLane,
	activities: facilitateActivities,
	body: (request) =>
		Effect.gen(function* () {
			for (let attempt = 1; ; attempt++) {
				const outcome = yield* facilitateActivities.activity("attempt", request, attempt);
				if (outcome === "decided") return;
				if (attempt === MAX_ATTEMPTS) return yield* new FacilitationFailed();
				yield* DurableClock.sleep({ name: `retry/${attempt}`, duration: RETRY_DELAY });
			}
		}),
	onFailure: "abandon",
	onReleased: "announceReleased",
});
