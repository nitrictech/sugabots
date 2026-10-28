import { Effect, Schema } from "effect";
import { agentSchema } from "./agents.ts";
import { repositoryEventSchema, repositoryPathSchema } from "./github.ts";
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

export const routineTriggerKindSchema = Schema.Literals(["cron", "webhook", "github"]);
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

/**
 * Senders whose own way of signing is known, so a routine they call needs
 * only the signing secret they make: GitHub, Stripe, Slack, and Linear,
 * which signs Standard Webhooks.
 */
export const WEBHOOK_SOURCES = ["github", "stripe", "slack", "linear"] as const;
export type WebhookSource = (typeof WEBHOOK_SOURCES)[number];

export const webhookHmacAlgorithmSchema = Schema.Literals(["sha1", "sha256", "sha512"]);
export type WebhookHmacAlgorithm = typeof webhookHmacAlgorithmSchema.Type;

export const webhookSignatureEncodingSchema = Schema.Literals(["hex", "base64"]);
export type WebhookSignatureEncoding = typeof webhookSignatureEncodingSchema.Type;

/**
 * How a webhook routine's caller proves it holds the routine's secret: as a
 * known source signs, or, for any other sender, one of the generic kinds.
 * `hmac` signs the raw body with the secret using `algorithm` and sends the
 * digest in `header`, written in `encoding`, optionally after the
 * algorithm's name (`sha256=`). The others send the secret itself.
 */
export const webhookAuthSchema = Schema.Union([
	Schema.Struct({ kind: Schema.Literals(WEBHOOK_SOURCES) }),
	Schema.Struct({
		kind: Schema.Literal("hmac"),
		header: webhookHeaderSchema,
		algorithm: webhookHmacAlgorithmSchema,
		encoding: webhookSignatureEncodingSchema,
	}),
	Schema.Struct({ kind: Schema.Literal("api_key"), header: webhookHeaderSchema }),
	Schema.Struct({ kind: Schema.Literal("bearer") }),
	Schema.Struct({ kind: Schema.Literal("basic"), username: webhookUsernameSchema }),
]);
export type WebhookAuth = typeof webhookAuthSchema.Type;
export type WebhookAuthKind = WebhookAuth["kind"];

/**
 * What marks the secrets made for each kind, so people can tell them apart.
 * Basic's password has none, and nor does a source's, which the sender makes.
 */
export const WEBHOOK_SECRET_PREFIXES: Record<WebhookAuthKind, string> = {
	hmac: "whsec_",
	api_key: "sk_rt_",
	bearer: "rtb_",
	basic: "",
	github: "",
	stripe: "",
	slack: "",
	linear: "",
};

/**
 * A webhook secret someone brings, such as the signing secret Linear, Slack
 * or Stripe makes for a webhook pointed at the routine. How long it must be
 * depends on its auth: see `webhookSecretLongEnough`.
 */
export const webhookSecretSchema = Schema.Trim.check(
	Schema.isMinLength(1),
	Schema.isMaxLength(MAX_WEBHOOK_SECRET_CHARACTERS),
);

/**
 * Whether `secret` is long enough for a webhook checked by `kind`. A source's
 * secret is the one its sender made, however long that is; one made up for
 * a generic webhook needs `MIN_WEBHOOK_SECRET_CHARACTERS`, to be hard to guess.
 */
export function webhookSecretLongEnough(kind: WebhookAuthKind, secret: string): boolean {
	const sendersOwn = (WEBHOOK_SOURCES as readonly string[]).includes(kind);
	return sendersOwn || secret.trim().length >= MIN_WEBHOOK_SECRET_CHARACTERS;
}

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

/**
 * A GitHub trigger's connection, its bot's pod's GitHub connection, the
 * repository there it watches, and the events there that start a run.
 */
const gitHubTriggerFields = {
	connectionId: uuidSchema,
	repository: repositoryPathSchema,
	events: Schema.Array(repositoryEventSchema).check(Schema.isMinLength(1)),
};

/** One of the things that start a routine; a routine may have several, of any kinds. */
export const routineTriggerSchema = Schema.Union([
	Schema.Struct({
		id: uuidSchema,
		kind: Schema.Literal("cron"),
		schedule: routineScheduleSchema,
		timezone: timezoneSchema,
		/** Null while the routine is paused. */
		nextScheduledAt: Schema.NullOr(isoTimestampSchema),
	}),
	Schema.Struct({ id: uuidSchema, kind: Schema.Literal("webhook"), auth: webhookAuthSchema }),
	Schema.Struct({ id: uuidSchema, kind: Schema.Literal("github"), ...gitHubTriggerFields }),
]);

export type RoutineTrigger = typeof routineTriggerSchema.Type;

/** A GitHub routine's connection, repository and the events there that run it. */
export type GitHubTrigger = Omit<Extract<RoutineTrigger, { kind: "github" }>, "kind" | "id">;

export const routineSchema = Schema.Struct({
	id: uuidSchema,
	workspaceId: uuidSchema,
	agentId: uuidSchema,
	name: routineNameSchema,
	instructions: routineInstructionsSchema,
	/** What starts it, in the order they were added; with none, it runs only when someone runs it. */
	triggers: Schema.Array(routineTriggerSchema),
	state: routineStateSchema,
	results: routineResultsSchema,
	/** The pod's chat its results are posted to; the pod's first chat when null. */
	chatId: Schema.NullOr(uuidSchema),
	createdById: Schema.NullOr(uuidSchema),
	/** The routine's own bot, when it made the routine at `createdById`'s request. */
	createdByAgentId: Schema.NullOr(uuidSchema),
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
 * A webhook trigger as written. Without `auth`, a new one takes a bearer
 * token and a changed one keeps how it checks callers. A null `secret` leaves
 * it without one, so its address alone runs the routine. Without `secret`,
 * one is made when it first needs one or its auth kind changes, and is
 * returned then.
 */
const webhookTriggerInputSchema = Schema.Struct({
	kind: Schema.Literal("webhook"),
	auth: Schema.optional(webhookAuthSchema),
	secret: Schema.optional(Schema.NullOr(webhookSecretSchema)),
	schedule: Schema.optional(Schema.Never),
	timezone: Schema.optional(Schema.Never),
});

const scheduledTriggerInputSchema = Schema.Struct({
	kind: Schema.Literal("cron"),
	schedule: routineScheduleSchema,
	timezone: timezoneSchema,
});

const gitHubTriggerInputSchema = Schema.Struct({
	kind: Schema.Literal("github"),
	...gitHubTriggerFields,
});

/** A trigger as written, to add to a routine or to replace one of its own of the same kind. */
export const routineTriggerInputSchema = Schema.Union([
	scheduledTriggerInputSchema,
	webhookTriggerInputSchema,
	gitHubTriggerInputSchema,
]);

export type RoutineTriggerInput = typeof routineTriggerInputSchema.Type;

/** At most this many triggers start one routine. */
export const MAX_ROUTINE_TRIGGERS = 20;

export const newRoutineSchema = Schema.Struct({
	name: routineNameSchema,
	instructions: routineInstructionsSchema,
	state: Schema.optional(routineStateSchema),
	results: Schema.optional(routineResultsSchema),
	chatId: Schema.optional(Schema.NullOr(uuidSchema)),
	triggers: Schema.Array(routineTriggerInputSchema).check(Schema.isMaxLength(MAX_ROUTINE_TRIGGERS)),
});

export type NewRoutine = typeof newRoutineSchema.Type;

/** A routine's own settings; its triggers change one by one, through their own endpoints. */
export const routineUpdateSchema = Schema.Struct({
	name: Schema.optional(routineNameSchema),
	instructions: Schema.optional(routineInstructionsSchema),
	state: Schema.optional(routineStateSchema),
	results: Schema.optional(routineResultsSchema),
	chatId: Schema.optional(Schema.NullOr(uuidSchema)),
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

export const routineExecutionTriggerKindSchema = Schema.Literals([
	"cron",
	"webhook",
	"github",
	"manual",
]);
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
		kind: Schema.Literal("github"),
		connectionId: uuidSchema,
		receivedAt: isoTimestampSchema,
		/** The service's id for the delivery, which a retry of it repeats. */
		deliveryId: Schema.String.check(
			Schema.isMinLength(1),
			Schema.isMaxLength(MAX_IDEMPOTENCY_KEY_CHARACTERS),
		),
		event: repositoryEventSchema,
		repository: Schema.String,
		/** Who did it, by their name at the service. */
		sender: Schema.String,
		/** Where to see it at the service. */
		url: Schema.String,
		/** The pull request or issue it is about, if any. */
		number: Schema.NullOr(Schema.Int),
		title: Schema.NullOr(Schema.String),
		/** What was written: a comment's or review's words, or a new issue's or pull request's description. */
		text: Schema.NullOr(Schema.String),
		/** The branch it is on, if any. */
		branch: Schema.NullOr(Schema.String),
		/** The comment associated with this execution, if any. */
		comment: Schema.optional(
			Schema.NullOr(
				Schema.Struct({
					id: Schema.Int,
					kind: Schema.Literals(["comment", "code_comment"]),
				}),
			),
		),
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
	/** The run's own thread. */
	threadId: uuidSchema,
	/** The routine's own thread, which lists the run beside its other runs. */
	conversationId: uuidSchema,
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

/**
 * The run whose result a message is, in the routine's thread or a pod's chat:
 * the routine, and the thread the run's work is in.
 */
export const routineResultOfSchema = Schema.Struct({
	executionId: uuidSchema,
	threadId: uuidSchema,
	routineId: uuidSchema,
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

/** A webhook trigger's new secret, or null when it was left without one. */
export const routineSecretSchema = Schema.Struct({ secret: Schema.NullOr(Schema.String) });
export type RoutineSecret = typeof routineSecretSchema.Type;

/**
 * A webhook trigger's current secret, for somebody who manages it. One with
 * `none` runs the routine for anybody who has its address; a `hashed` one has
 * a bearer token made before secrets were kept, which only its hash checks.
 */
export const routineCurrentSecretSchema = Schema.Union([
	Schema.Struct({ kind: Schema.Literal("set"), secret: Schema.String }),
	Schema.Struct({ kind: Schema.Literal("none") }),
	Schema.Struct({ kind: Schema.Literal("hashed") }),
]);
export type RoutineCurrentSecret = typeof routineCurrentSecretSchema.Type;

/**
 * Replaces a webhook trigger's secret with `secret`, with a new one when it
 * is absent, or with none when it is null, so the address alone runs it.
 */
export const routineSecretReplacementSchema = Schema.Struct({
	secret: Schema.optional(Schema.NullOr(webhookSecretSchema)),
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

/** A routine as written, and the secrets of any webhook triggers the write made one for, shown once. */
export const routineWriteResultSchema = Schema.Struct({
	routine: routineSchema,
	secrets: Schema.Array(Schema.Struct({ triggerId: uuidSchema, secret: Schema.String })),
});
export type RoutineWriteResult = typeof routineWriteResultSchema.Type;

export const routineSchedulePreviewSchema = Schema.Struct({
	schedule: routineScheduleSchema,
	timezone: timezoneSchema,
});
export type RoutineSchedulePreview = typeof routineSchedulePreviewSchema.Type;

export const routineScheduleOccurrencesSchema = Schema.Array(isoTimestampSchema);
export type RoutineScheduleOccurrences = typeof routineScheduleOccurrencesSchema.Type;
