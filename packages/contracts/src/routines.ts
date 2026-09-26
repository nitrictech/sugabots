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

export const routineTriggerSchema = Schema.Union([
	Schema.Struct({
		kind: Schema.Literal("cron"),
		expression: cronExpressionSchema,
		timezone: timezoneSchema,
		nextScheduledAt: Schema.NullOr(isoTimestampSchema),
	}),
	Schema.Struct({ kind: Schema.Literal("webhook") }),
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

const newRoutineBaseSchema = {
	name: routineNameSchema,
	instructions: routineInstructionsSchema,
	state: Schema.optional(routineStateSchema),
};

export const newRoutineSchema = Schema.Union([
	Schema.Struct({
		...newRoutineBaseSchema,
		trigger: Schema.Struct({
			kind: Schema.Literal("cron"),
			expression: cronExpressionSchema,
			timezone: timezoneSchema,
		}),
	}),
	Schema.Struct({
		...newRoutineBaseSchema,
		trigger: Schema.Struct({
			kind: Schema.Literal("webhook"),
			expression: Schema.optional(Schema.Never),
			timezone: Schema.optional(Schema.Never),
		}),
	}),
]);

export type NewRoutine = typeof newRoutineSchema.Type;

export const routineUpdateSchema = Schema.Struct({
	name: Schema.optional(routineNameSchema),
	instructions: Schema.optional(routineInstructionsSchema),
	state: Schema.optional(routineStateSchema),
	trigger: Schema.optional(
		Schema.Union([
			Schema.Struct({
				kind: Schema.Literal("cron"),
				expression: cronExpressionSchema,
				timezone: timezoneSchema,
			}),
			Schema.Struct({
				kind: Schema.Literal("webhook"),
				expression: Schema.optional(Schema.Never),
				timezone: Schema.optional(Schema.Never),
			}),
		]),
	),
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

export const manualRoutineRunSchema = Schema.Struct({ requestId: uuidSchema });
export type ManualRoutineRun = typeof manualRoutineRunSchema.Type;

export const acceptedRoutineExecutionSchema = Schema.Struct({
	executionId: uuidSchema,
	threadId: uuidSchema,
	duplicate: Schema.Boolean,
});

export type AcceptedRoutineExecution = typeof acceptedRoutineExecutionSchema.Type;

export const routineSecretSchema = Schema.Struct({
	secret: Schema.String.check(Schema.isMinLength(32)),
});
export type RoutineSecret = typeof routineSecretSchema.Type;

export const acceptedRoutineWebhookSchema = Schema.Struct({
	executionId: uuidSchema,
	duplicate: Schema.Boolean,
});
export type AcceptedRoutineWebhook = typeof acceptedRoutineWebhookSchema.Type;

export const routineWriteResultSchema = Schema.Struct({
	routine: routineSchema,
	secret: Schema.NullOr(Schema.String.check(Schema.isMinLength(32))),
});
export type RoutineWriteResult = typeof routineWriteResultSchema.Type;

export const routineSchedulePreviewSchema = Schema.Struct({
	expression: cronExpressionSchema,
	timezone: timezoneSchema,
});
export type RoutineSchedulePreview = typeof routineSchedulePreviewSchema.Type;

export const routineScheduleOccurrencesSchema = Schema.Array(isoTimestampSchema);
export type RoutineScheduleOccurrences = typeof routineScheduleOccurrencesSchema.Type;
