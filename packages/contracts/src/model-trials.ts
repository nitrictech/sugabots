import { Schema } from "effect";
import { modelIdSchema, systemAgentKeySchema } from "./agents.ts";

/**
 * Trying a model out on a system agent before a workspace relies on it.
 *
 * A system agent's model is chosen once and then runs unattended on every message, so
 * "it seemed fine when I tried it" is not enough: what matters is how often it
 * is right, which is what a trial reports.
 */

/** The jobs a model can be tried on: the system agents, by their own keys. */
export const trialSystemAgentSchema = systemAgentKeySchema;
export type TrialSystemAgent = typeof trialSystemAgentSchema.Type;

export const newModelTrialSchema = Schema.Struct({
	systemAgentKey: trialSystemAgentSchema,
	model: modelIdSchema,
});
export type NewModelTrial = typeof newModelTrialSchema.Type;

/**
 * How good the model is at the job.
 *
 * Four words rather than a percentage, because the decision is "use this or
 * pick another one" and a number invites haggling over a model that is wrong
 * one time in three.
 */
export const trialRatingSchema = Schema.Literals(["excellent", "good", "poor", "terrible"]);
export type TrialRating = typeof trialRatingSchema.Type;

export const trialCaseResultSchema = Schema.Struct({
	/** What this checks, in the words somebody choosing a model would use. */
	name: Schema.String,
	passed: Schema.Int.check(Schema.isGreaterThanOrEqualTo(0)),
	attempts: Schema.Int.check(Schema.isGreaterThan(0)),
	/** One answer that was not accepted, so the failure is legible. */
	example: Schema.optional(Schema.String),
});
export type TrialCaseResult = typeof trialCaseResultSchema.Type;

export const trialAccuracySchema = Schema.Struct({
	passed: Schema.Int.check(Schema.isGreaterThanOrEqualTo(0)),
	attempts: Schema.Int.check(Schema.isGreaterThan(0)),
	/** Answers accepted, as a share of every attempt. */
	share: Schema.Finite.check(Schema.isBetween({ minimum: 0, maximum: 1 })),
	/** The least a system agent can be right and still be worth running. */
	needed: Schema.Finite.check(Schema.isBetween({ minimum: 0, maximum: 1 })),
	rating: trialRatingSchema,
});
export type TrialAccuracy = typeof trialAccuracySchema.Type;

export const trialSpeedSchema = Schema.Struct({
	/** The middle time, so one cold start does not stand for the model. */
	typicalMs: Schema.Finite.check(Schema.isGreaterThanOrEqualTo(0)),
	slowestMs: Schema.Finite.check(Schema.isGreaterThanOrEqualTo(0)),
	/** How long this system agent can take before the wait is somebody's problem. */
	budgetMs: Schema.Finite.check(Schema.isGreaterThan(0)),
	rating: trialRatingSchema,
});
export type TrialSpeed = typeof trialSpeedSchema.Type;

export const modelTrialSchema = Schema.Struct({
	systemAgentKey: trialSystemAgentSchema,
	model: modelIdSchema,
	/** The worse of the two: a system agent that is slow is no use, however right. */
	rating: trialRatingSchema,
	accuracy: trialAccuracySchema,
	speed: trialSpeedSchema,
	/** What is wrong and what would be good enough, in sentences. */
	verdict: Schema.Array(Schema.String),
	cases: Schema.Array(trialCaseResultSchema),
});
export type ModelTrial = typeof modelTrialSchema.Type;
