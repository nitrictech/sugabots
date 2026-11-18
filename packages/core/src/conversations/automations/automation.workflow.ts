/**
 * An automation's run, as a durable workflow: its definition and the order of its
 * steps. What each step does lives behind `AutomationSteps`, implemented in
 * `steps.ts`.
 *
 * A run starts its turn, then waits until settlement records how it ended.
 * Runs of one automation wait in its lane, so they happen one at a time.
 */
import { Activities } from "@sugabots/workflow/activities";
import { Context, Duration, Effect, Schema } from "effect";
import { DurableClock, DurableDeferred, Workflow } from "effect/unstable/workflow";
import { Lanes } from "../../workflows/lanes.ts";

/**
 * A run as its workflow's payload. The workflow engine and the lanes store
 * payloads, so their keys keep the names the first runs were stored with.
 */
export const StoredRun = Schema.Struct({
	routineId: Schema.String,
	executionId: Schema.String,
});
export type StoredRun = typeof StoredRun.Type;

/** The run a workflow carries out: its automation, and the run itself. */
export interface AutomationRun {
	readonly automationId: string;
	readonly runId: string;
}

export const storedRun = (run: AutomationRun): StoredRun => ({
	routineId: run.automationId,
	executionId: run.runId,
});

export const runOfStored = (stored: StoredRun): AutomationRun => ({
	automationId: stored.routineId,
	runId: stored.executionId,
});

/** The workflow's name, which the workflow engine and the lanes store. */
export const Automation = Workflow.make("routine", {
	payload: StoredRun,
	idempotencyKey: (stored) => stored.executionId,
});

/** One run at a time per automation. Lanes store their keys, so this one keeps its old form. */
export const automationLane = (run: Pick<AutomationRun, "automationId">) =>
	`routine:${run.automationId}`;

/** Settlement recorded how the run ended. */
const automationSettled = DurableDeferred.make("settled");

export class AutomationSteps extends Context.Service<
	AutomationSteps,
	{
		/** Marks the run started and asks for its turn. Does nothing once the run has ended. */
		readonly start: (run: StoredRun) => Effect.Effect<void>;
		/** Settles the run if its work is done. Returns whether it has ended. */
		readonly settle: (run: StoredRun) => Effect.Effect<boolean>;
		/** Records the run as failed, stopping its work, when its workflow fails. */
		readonly fail: (run: StoredRun) => Effect.Effect<void>;
	}
>()("@sugabots/core/AutomationSteps") {}

/** Each check whether the run has settled is a separate activity, numbered from 0. */
const automationActivities = Activities.fromService<StoredRun>()(AutomationSteps, {
	start: {},
	settle: { input: Schema.Int, success: Schema.Boolean },
	fail: {},
});

/**
 * Settlement signals the run once it has ended, after its transaction commits.
 * A signal lost to a crash in between is covered by checking again this often.
 */
const SETTLEMENT_CHECK_INTERVAL = Duration.minutes(1);

export const automationWorkflow = Lanes.workflow(Automation, {
	lane: (stored) => automationLane(runOfStored(stored)),
	activities: automationActivities,
	body: (run) =>
		Effect.gen(function* () {
			yield* automationActivities.activity("start", run);
			for (let check = 0; ; check++) {
				if (yield* automationActivities.activity("settle", run, check)) return;
				yield* DurableDeferred.raceAll({
					name: `settlement/${check}`,
					success: Schema.Void,
					error: Schema.Never,
					effects: [
						DurableDeferred.await(automationSettled),
						DurableClock.sleep({ name: `check/${check}`, duration: SETTLEMENT_CHECK_INTERVAL }),
					],
				});
			}
		}),
	onFailure: "fail",
});

/** Tells a run's workflow that settlement recorded how it ended. */
export const signalSettled = (run: AutomationRun) =>
	Effect.flatMap(Automation.executionId(storedRun(run)), (executionId) =>
		DurableDeferred.succeed(automationSettled, {
			token: DurableDeferred.tokenFromExecutionId(automationSettled, {
				workflow: Automation,
				executionId,
			}),
			value: undefined,
		}),
	);
