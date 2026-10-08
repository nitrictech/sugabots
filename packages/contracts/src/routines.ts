import { Effect, Schema } from "effect";
import { agentSchema } from "./agents.ts";
import { podSlugSchema } from "./pods.ts";
import { isoTimestampSchema } from "./timestamps.ts";
import { uuidSchema } from "./uuid.ts";

export const MAX_ROUTINE_NAME_CHARACTERS = 80;
export const MAX_ROUTINE_INSTRUCTIONS_CHARACTERS = 20_000;
export const MAX_CRON_EXPRESSION_CHARACTERS = 200;
export const MAX_TIMEZONE_CHARACTERS = 100;
export const MAX_IDEMPOTENCY_KEY_CHARACTERS = 200;
export const MAX_ROUTINE_SCHEDULE_TIMES = 8;
export const MAX_EVERY_DAYS = 30;
export const MAX_EVERY_WEEKS = 12;
export const MAX_EVERY_MONTHS = 12;
const MINUTES_PER_DAY = 24 * 60;
export const MAX_WEBHOOK_HEADER_CHARACTERS = 100;
export const MAX_WEBHOOK_USERNAME_CHARACTERS = 100;
export const MIN_WEBHOOK_SECRET_CHARACTERS = 16;
export const MAX_WEBHOOK_SECRET_CHARACTERS = 500;
export const DEFAULT_ROUTINE_EXECUTION_PAGE_LIMIT = 20;
export const MAX_ROUTINE_EXECUTION_PAGE_LIMIT = 100;

const routineNameSchema = Schema.Trim.check(
	Schema.isMinLength(1),
	Schema.isMaxLength(MAX_ROUTINE_NAME_CHARACTERS),
);

const routineInstructionsSchema = Schema.Trim.check(
	Schema.isMinLength(1),
	Schema.isMaxLength(MAX_ROUTINE_INSTRUCTIONS_CHARACTERS),
);

const cronExpressionSchema = Schema.Trim.check(
	Schema.isMinLength(1),
	Schema.isMaxLength(MAX_CRON_EXPRESSION_CHARACTERS),
);

const timezoneSchema = Schema.Trim.check(
	Schema.isMinLength(1),
	Schema.isMaxLength(MAX_TIMEZONE_CHARACTERS),
);

export const routineStateSchema = Schema.Literals(["enabled", "paused"]);
export type RoutineState = typeof routineStateSchema.Type;

export const routineTriggerKindSchema = Schema.Literals(["cron", "webhook"]);
export type RoutineTriggerKind = typeof routineTriggerKindSchema.Type;

/**
 * Where a run's result goes: kept in the run's own thread, or also posted in
 * the agent's chat as the agent's last reply, for people to read and answer.
 */
export const routineResultsSchema = Schema.Literals(["keep_in_run", "post_to_chat"]);
export type RoutineResults = typeof routineResultsSchema.Type;

const webhookHeaderSchema = Schema.Trim.check(
	Schema.isMinLength(1),
	Schema.isMaxLength(MAX_WEBHOOK_HEADER_CHARACTERS),
	// An HTTP field name: RFC 9110's token characters.
	Schema.isPattern(/^[!#$%&'*+.^_`|~0-9A-Za-z-]+$/),
);

const webhookUsernameSchema = Schema.Trim.check(
	Schema.isMinLength(1),
	Schema.isMaxLength(MAX_WEBHOOK_USERNAME_CHARACTERS),
	// Basic auth joins the username and password with the first colon.
	Schema.isPattern(/^[^:]+$/),
);

export const webhookHmacAlgorithmSchema = Schema.Literals(["sha256", "sha512"]);
export type WebhookHmacAlgorithm = typeof webhookHmacAlgorithmSchema.Type;

/**
 * How a webhook routine's caller proves it holds the routine's secret.
 *
 * `hmac` signs the request rather than sending the secret. In the `body`
 * format the signature is over the raw body, in `header`, as hex or base64,
 * optionally prefixed with the algorithm (`sha256=`): Linear, GitHub and
 * Shopify sign this way. `slack` and `stripe` are those services' own
 * formats, which sign a timestamp with the body, so a delivery replayed later
 * is refused.
 */
export const webhookAuthSchema = Schema.Union([
	Schema.Struct({
		kind: Schema.Literal("hmac"),
		format: Schema.Literal("body"),
		header: webhookHeaderSchema,
		algorithm: webhookHmacAlgorithmSchema,
	}),
	Schema.Struct({ kind: Schema.Literal("hmac"), format: Schema.Literal("slack") }),
	Schema.Struct({ kind: Schema.Literal("hmac"), format: Schema.Literal("stripe") }),
	Schema.Struct({ kind: Schema.Literal("api_key"), header: webhookHeaderSchema }),
	Schema.Struct({ kind: Schema.Literal("bearer") }),
	Schema.Struct({ kind: Schema.Literal("basic"), username: webhookUsernameSchema }),
]);
export type WebhookAuth = typeof webhookAuthSchema.Type;
export type WebhookAuthKind = WebhookAuth["kind"];

/**
 * A webhook secret someone brings, such as the signing secret Linear, Slack
 * or Stripe makes for a webhook pointed at the routine.
 */
export const webhookSecretSchema = Schema.Trim.check(
	Schema.isMinLength(MIN_WEBHOOK_SECRET_CHARACTERS),
	Schema.isMaxLength(MAX_WEBHOOK_SECRET_CHARACTERS),
);

const minutesPastMidnightSchema = Schema.Int.check(
	Schema.isBetween({ minimum: 0, maximum: MINUTES_PER_DAY - 1 }),
);

/** The times of day a schedule runs at, as minutes past midnight, each once. */
const scheduleTimesSchema = Schema.Array(minutesPastMidnightSchema).check(
	Schema.isMinLength(1),
	Schema.isMaxLength(MAX_ROUTINE_SCHEDULE_TIMES),
	Schema.makeFilter((times: readonly number[]) => new Set(times).size === times.length, {
		expected: "each time once",
	}),
);

export const weekdaySchema = Schema.Literals(["mon", "tue", "wed", "thu", "fri", "sat", "sun"]);
export type Weekday = typeof weekdaySchema.Type;

/** A calendar date, as `YYYY-MM-DD`. */
const calendarDateSchema = Schema.String.check(Schema.isPattern(/^\d{4}-\d{2}-\d{2}$/));

const everySchema = (maximum: number) =>
	Schema.Int.check(Schema.isBetween({ minimum: 1, maximum }));

/**
 * When a scheduled routine runs, in its time zone: every `every` days, weeks
 * or months counted from `startsOn`, at each of `times`; on `days` of those
 * weeks, or on `dayOfMonth` of those months. A `cron` schedule is a cron
 * expression kept as it was written, for routines made before schedules were
 * picked this way.
 */
export const routineScheduleSchema = Schema.Union([
	Schema.Struct({
		repeat: Schema.Literal("daily"),
		every: everySchema(MAX_EVERY_DAYS),
		times: scheduleTimesSchema,
		startsOn: calendarDateSchema,
	}),
	Schema.Struct({
		repeat: Schema.Literal("weekly"),
		every: everySchema(MAX_EVERY_WEEKS),
		days: Schema.Array(weekdaySchema).check(
			Schema.isMinLength(1),
			Schema.makeFilter((days: readonly Weekday[]) => new Set(days).size === days.length, {
				expected: "each day once",
			}),
		),
		times: scheduleTimesSchema,
		startsOn: calendarDateSchema,
	}),
	Schema.Struct({
		repeat: Schema.Literal("monthly"),
		every: everySchema(MAX_EVERY_MONTHS),
		/** 1 to 28, so it falls in every month, or the month's last day. */
		dayOfMonth: Schema.Union([
			Schema.Int.check(Schema.isBetween({ minimum: 1, maximum: 28 })),
			Schema.Literal("last"),
		]),
		times: scheduleTimesSchema,
		startsOn: calendarDateSchema,
	}),
	Schema.Struct({ repeat: Schema.Literal("cron"), expression: cronExpressionSchema }),
]);
export type RoutineSchedule = typeof routineScheduleSchema.Type;

/** A schedule picked by its parts rather than written as cron. */
export type CalendarSchedule = Exclude<RoutineSchedule, { repeat: "cron" }>;

export const routineTriggerSchema = Schema.Union([
	Schema.Struct({
		kind: Schema.Literal("cron"),
		schedule: routineScheduleSchema,
		timezone: timezoneSchema,
		nextScheduledAt: Schema.NullOr(isoTimestampSchema),
	}),
	Schema.Struct({ kind: Schema.Literal("webhook"), auth: webhookAuthSchema }),
]);

export type RoutineTrigger = typeof routineTriggerSchema.Type;

export const routineSchema = Schema.Struct({
	id: uuidSchema,
	workspaceId: uuidSchema,
	agentId: uuidSchema,
	name: routineNameSchema,
	instructions: routineInstructionsSchema,
	trigger: routineTriggerSchema,
	state: routineStateSchema,
	results: routineResultsSchema,
	createdById: Schema.NullOr(uuidSchema),
	createdAt: isoTimestampSchema,
	updatedAt: isoTimestampSchema,
});

export type Routine = typeof routineSchema.Type;

/** A routine in the workspace list, with the bot it belongs to and that bot's pod. */
export const workspaceRoutineSchema = Schema.Struct({
	routine: routineSchema,
	agent: agentSchema,
	pod: Schema.Struct({ id: uuidSchema, slug: podSlugSchema }),
});

export type WorkspaceRoutine = typeof workspaceRoutineSchema.Type;

/** Every routine on a bot the person can reach, by name. */
export const workspaceRoutineListSchema = Schema.Struct({
	items: Schema.mutable(Schema.Array(workspaceRoutineSchema)),
});

export type WorkspaceRoutineList = typeof workspaceRoutineListSchema.Type;

/**
 * A webhook trigger as written. Without `auth`, a new routine takes a bearer
 * token and a changed one keeps how it checks callers. Without `secret`, one
 * is made when the routine first needs one or its auth kind changes, and is
 * returned then.
 */
const webhookTriggerInputSchema = Schema.Struct({
	kind: Schema.Literal("webhook"),
	auth: Schema.optional(webhookAuthSchema),
	secret: Schema.optional(webhookSecretSchema),
	schedule: Schema.optional(Schema.Never),
	timezone: Schema.optional(Schema.Never),
});

const scheduledTriggerInputSchema = Schema.Struct({
	kind: Schema.Literal("cron"),
	schedule: routineScheduleSchema,
	timezone: timezoneSchema,
});

const newRoutineBaseSchema = {
	name: routineNameSchema,
	instructions: routineInstructionsSchema,
	state: Schema.optional(routineStateSchema),
	results: Schema.optional(routineResultsSchema),
};

export const newRoutineSchema = Schema.Union([
	Schema.Struct({ ...newRoutineBaseSchema, trigger: scheduledTriggerInputSchema }),
	Schema.Struct({ ...newRoutineBaseSchema, trigger: webhookTriggerInputSchema }),
]);

export type NewRoutine = typeof newRoutineSchema.Type;

export const routineUpdateSchema = Schema.Struct({
	name: Schema.optional(routineNameSchema),
	instructions: Schema.optional(routineInstructionsSchema),
	state: Schema.optional(routineStateSchema),
	results: Schema.optional(routineResultsSchema),
	trigger: Schema.optional(Schema.Union([scheduledTriggerInputSchema, webhookTriggerInputSchema])),
});

export type RoutineUpdate = typeof routineUpdateSchema.Type;

export const routineExecutionStateSchema = Schema.Literals([
	"queued",
	"running",
	"completed",
	"failed",
	"cancelled",
]);

export type RoutineExecutionState = typeof routineExecutionStateSchema.Type;

export const routineExecutionTriggerKindSchema = Schema.Literals(["cron", "webhook", "manual"]);
export type RoutineExecutionTriggerKind = typeof routineExecutionTriggerKindSchema.Type;

const jsonValueSchema = Schema.Unknown.check(
	Schema.makeFilter(Schema.is(Schema.Json), { expected: "a JSON value" }),
);

export const routineExecutionTriggerSchema = Schema.Union([
	Schema.Struct({
		kind: Schema.Literal("cron"),
		scheduledAt: isoTimestampSchema,
		acceptedAt: isoTimestampSchema,
	}),
	Schema.Struct({
		kind: Schema.Literal("webhook"),
		receivedAt: isoTimestampSchema,
		idempotencyKey: Schema.NullOr(
			Schema.String.check(
				Schema.isMinLength(1),
				Schema.isMaxLength(MAX_IDEMPOTENCY_KEY_CHARACTERS),
			),
		),
		payload: jsonValueSchema,
	}),
	Schema.Struct({
		kind: Schema.Literal("manual"),
		requestedAt: isoTimestampSchema,
		requestedByUserId: uuidSchema,
		requestId: uuidSchema,
	}),
]);

export type RoutineExecutionTrigger = typeof routineExecutionTriggerSchema.Type;

export const routineExecutionSchema = Schema.Struct({
	id: uuidSchema,
	routineId: uuidSchema,
	workspaceId: uuidSchema,
	agentId: uuidSchema,
	threadId: uuidSchema,
	routineName: routineNameSchema,
	instructions: routineInstructionsSchema,
	trigger: routineExecutionTriggerSchema,
	state: routineExecutionStateSchema,
	error: Schema.NullOr(Schema.String),
	acceptedAt: isoTimestampSchema,
	startedAt: Schema.NullOr(isoTimestampSchema),
	finishedAt: Schema.NullOr(isoTimestampSchema),
});

export type RoutineExecution = typeof routineExecutionSchema.Type;

export const routineExecutionSummarySchema = Schema.Struct({
	executionId: uuidSchema,
	routineId: uuidSchema,
	routineName: routineNameSchema,
	triggerKind: routineExecutionTriggerKindSchema,
	triggeredAt: isoTimestampSchema,
});
export type RoutineExecutionSummary = typeof routineExecutionSummarySchema.Type;

export const routineExecutionPageQuerySchema = Schema.Struct({
	cursor: Schema.optional(Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(200))),
	limit: Schema.String.check(Schema.isPattern(/^\d+$/)).pipe(
		Schema.decodeTo(Schema.FiniteFromString),
		Schema.check(
			Schema.isInt(),
			Schema.isBetween({ minimum: 1, maximum: MAX_ROUTINE_EXECUTION_PAGE_LIMIT }),
		),
		Schema.withDecodingDefault(Effect.succeed(String(DEFAULT_ROUTINE_EXECUTION_PAGE_LIMIT))),
	),
});
export type RoutineExecutionPageQuery = typeof routineExecutionPageQuerySchema.Type;

export const routineExecutionPageSchema = Schema.Struct({
	items: Schema.mutable(Schema.Array(routineExecutionSchema)),
	nextCursor: Schema.NullOr(Schema.String),
});
export type RoutineExecutionPage = typeof routineExecutionPageSchema.Type;

export const routineTriggerAuthorSchema = Schema.Struct({
	kind: Schema.Literal("routine_trigger"),
	executionId: uuidSchema,
	routineName: routineNameSchema,
	triggerKind: routineExecutionTriggerKindSchema,
});

export type RoutineTriggerAuthor = typeof routineTriggerAuthorSchema.Type;

/** The run whose result a message in the agent's chat is, and the thread its work is in. */
export const routineResultOfSchema = Schema.Struct({
	executionId: uuidSchema,
	threadId: uuidSchema,
	routineName: routineNameSchema,
});

export type RoutineResultOf = typeof routineResultOfSchema.Type;

export const manualRoutineRunSchema = Schema.Struct({ requestId: uuidSchema });
export type ManualRoutineRun = typeof manualRoutineRunSchema.Type;

export const acceptedRoutineExecutionSchema = Schema.Struct({
	executionId: uuidSchema,
	threadId: uuidSchema,
	duplicate: Schema.Boolean,
});

export type AcceptedRoutineExecution = typeof acceptedRoutineExecutionSchema.Type;

export const routineSecretSchema = Schema.Struct({ secret: Schema.String });
export type RoutineSecret = typeof routineSecretSchema.Type;

/** Replaces a webhook routine's secret with `secret`, or with a new one when it is absent. */
export const routineSecretReplacementSchema = Schema.Struct({
	secret: Schema.optional(webhookSecretSchema),
});
export type RoutineSecretReplacement = typeof routineSecretReplacementSchema.Type;

export const acceptedRoutineWebhookSchema = Schema.Struct({
	executionId: uuidSchema,
	duplicate: Schema.Boolean,
});
export type AcceptedRoutineWebhook = typeof acceptedRoutineWebhookSchema.Type;

/** The answer to Slack's check that it may send events to the routine's address. */
export const routineWebhookChallengeSchema = Schema.Struct({ challenge: Schema.String });
export type RoutineWebhookChallenge = typeof routineWebhookChallengeSchema.Type;

export const routineWriteResultSchema = Schema.Struct({
	routine: routineSchema,
	secret: Schema.NullOr(Schema.String),
});
export type RoutineWriteResult = typeof routineWriteResultSchema.Type;

export const routineSchedulePreviewSchema = Schema.Struct({
	schedule: routineScheduleSchema,
	timezone: timezoneSchema,
});
export type RoutineSchedulePreview = typeof routineSchedulePreviewSchema.Type;

export const routineScheduleOccurrencesSchema = Schema.Array(isoTimestampSchema);
export type RoutineScheduleOccurrences = typeof routineScheduleOccurrencesSchema.Type;
