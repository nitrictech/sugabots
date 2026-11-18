import { Effect, Schema } from "effect";
import isISO8601 from "validator/lib/isISO8601.js";
import { botSchema } from "./bots.ts";
import { repositoryEventSchema, repositoryPathSchema } from "./github.ts";
import { MAX_TIMEZONE_CHARACTERS } from "./time-zones.ts";
import { isoTimestampSchema } from "./timestamps.ts";
import { uuidSchema } from "./uuid.ts";

export const MAX_AUTOMATION_NAME_CHARACTERS = 80;
export const MAX_AUTOMATION_INSTRUCTIONS_CHARACTERS = 20_000;
export const MAX_CRON_EXPRESSION_CHARACTERS = 200;
export const MAX_IDEMPOTENCY_KEY_CHARACTERS = 200;
export const MAX_AUTOMATION_SCHEDULE_TIMES = 8;
export const MAX_EVERY_DAYS = 30;
export const MAX_EVERY_WEEKS = 12;
export const MAX_EVERY_MONTHS = 12;
const MINUTES_PER_DAY = 24 * 60;
export const MAX_WEBHOOK_HEADER_CHARACTERS = 100;
export const MAX_WEBHOOK_USERNAME_CHARACTERS = 100;
export const MAX_WEBHOOK_FILTER_CONDITIONS = 10;
export const MAX_WEBHOOK_FILTER_VALUES = 20;
export const MAX_WEBHOOK_FILTER_TEXT_CHARACTERS = 200;
export const MIN_WEBHOOK_SECRET_CHARACTERS = 16;
export const MAX_WEBHOOK_SECRET_CHARACTERS = 500;
export const DEFAULT_RUN_PAGE_LIMIT = 20;
export const MAX_RUN_PAGE_LIMIT = 100;

const automationNameSchema = Schema.Trim.check(
	Schema.isMinLength(1),
	Schema.isMaxLength(MAX_AUTOMATION_NAME_CHARACTERS),
);

const automationInstructionsSchema = Schema.Trim.check(
	Schema.isMinLength(1),
	Schema.isMaxLength(MAX_AUTOMATION_INSTRUCTIONS_CHARACTERS),
);

const cronExpressionSchema = Schema.Trim.check(
	Schema.isMinLength(1),
	Schema.isMaxLength(MAX_CRON_EXPRESSION_CHARACTERS),
);

const timezoneSchema = Schema.Trim.check(
	Schema.isMinLength(1),
	Schema.isMaxLength(MAX_TIMEZONE_CHARACTERS),
);

export const automationStateSchema = Schema.Literals(["enabled", "paused"]);
export type AutomationState = typeof automationStateSchema.Type;

export const automationTriggerKindSchema = Schema.Literals(["schedule", "webhook", "github"]);
export type AutomationTriggerKind = typeof automationTriggerKindSchema.Type;

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
 * Senders whose own way of signing is known, so an automation they call needs
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
 * How a webhook automation's caller proves it holds the automation's secret: as a
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

/** The delivery ID header selected for new generic webhooks in the editor. */
export const DEFAULT_DELIVERY_ID_HEADER = "Idempotency-Key";

/** A header name, null to disable deduplication, or absent to retain automatic detection. */
const webhookDeliveryIdHeaderSchema = Schema.optional(Schema.NullOr(webhookHeaderSchema));

/**
 * A test of a webhook call's JSON body: the text at `path`, keys joined by
 * dots, is one of `oneOf`. Arrays on the way are searched, so
 * `data.labels.name` is met by any label with the name. Numbers and
 * booleans are compared as the text they print as.
 */
export const webhookConditionSchema = Schema.Struct({
	path: Schema.Trim.check(
		Schema.isMinLength(1),
		Schema.isMaxLength(MAX_WEBHOOK_FILTER_TEXT_CHARACTERS),
		// No empty keys, as in `a..b` or `.a`.
		Schema.isPattern(/^[^.]+(\.[^.]+)*$/),
	),
	oneOf: Schema.Array(
		Schema.String.check(Schema.isMaxLength(MAX_WEBHOOK_FILTER_TEXT_CHARACTERS)),
	).check(Schema.isMinLength(1), Schema.isMaxLength(MAX_WEBHOOK_FILTER_VALUES)),
});
export type WebhookCondition = typeof webhookConditionSchema.Type;

/**
 * What a webhook trigger requires of a call before it starts a run: every
 * condition must be met. A call that fails one is answered but runs nothing.
 * None, as for a trigger made before filters, runs every call.
 */
const webhookFilterSchema = Schema.Array(webhookConditionSchema).check(
	Schema.isMaxLength(MAX_WEBHOOK_FILTER_CONDITIONS),
);

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
 * or Stripe makes for a webhook pointed at the automation. How long it must be
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
	Schema.isMaxLength(MAX_AUTOMATION_SCHEDULE_TIMES),
	Schema.makeFilter((times: readonly number[]) => new Set(times).size === times.length, {
		expected: "each time once",
	}),
);

export const weekdaySchema = Schema.Literals(["mon", "tue", "wed", "thu", "fri", "sat", "sun"]);
export type Weekday = typeof weekdaySchema.Type;

/** A calendar date that exists, as `YYYY-MM-DD`. */
const calendarDateSchema = Schema.String.check(
	Schema.isPattern(/^\d{4}-\d{2}-\d{2}$/),
	Schema.makeFilter((date) => isISO8601(date, { strict: true }), {
		message: "Expected a date that exists",
	}),
);

const everySchema = (maximum: number) =>
	Schema.Int.check(Schema.isBetween({ minimum: 1, maximum }));

/**
 * When a scheduled automation runs, in its time zone: every `every` days, weeks
 * or months counted from `startsOn`, at each of `times`; on `days` of those
 * weeks, or on `dayOfMonth` of those months. A `cron` schedule is a cron
 * expression kept as it was written, for automations made before schedules were
 * picked this way.
 */
export const automationScheduleSchema = Schema.Union([
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
export type AutomationSchedule = typeof automationScheduleSchema.Type;

/** A schedule picked by its parts rather than written as cron. */
export type CalendarSchedule = Exclude<AutomationSchedule, { repeat: "cron" }>;

/**
 * A GitHub trigger's connection, its bot's GitHub connection, the
 * repository there it watches, and the events there that start a run.
 */
const gitHubTriggerFields = {
	connectionId: uuidSchema,
	repository: repositoryPathSchema,
	events: Schema.Array(repositoryEventSchema).check(Schema.isMinLength(1)),
};

/** One of the things that start an automation; an automation may have several, of any kinds. */
export const automationTriggerSchema = Schema.Union([
	Schema.Struct({
		id: uuidSchema,
		kind: Schema.Literal("schedule"),
		schedule: automationScheduleSchema,
		timezone: timezoneSchema,
		/** Null while the automation is paused. */
		nextScheduledAt: Schema.NullOr(isoTimestampSchema),
	}),
	Schema.Struct({
		id: uuidSchema,
		kind: Schema.Literal("webhook"),
		auth: webhookAuthSchema,
		deliveryIdHeader: webhookDeliveryIdHeaderSchema,
		/** Left out while there is none. */
		filter: Schema.optional(webhookFilterSchema),
	}),
	Schema.Struct({ id: uuidSchema, kind: Schema.Literal("github"), ...gitHubTriggerFields }),
]);

export type AutomationTrigger = typeof automationTriggerSchema.Type;

/** A GitHub automation's connection, repository and the events there that run it. */
export type GitHubTrigger = Omit<Extract<AutomationTrigger, { kind: "github" }>, "kind" | "id">;

export const automationSchema = Schema.Struct({
	id: uuidSchema,
	workspaceId: uuidSchema,
	botId: uuidSchema,
	name: automationNameSchema,
	instructions: automationInstructionsSchema,
	/** What starts it, in the order they were added; with none, it runs only when someone runs it. */
	triggers: Schema.Array(automationTriggerSchema),
	state: automationStateSchema,
	createdById: Schema.NullOr(uuidSchema),
	/** The automation's own bot, when it made the automation at `createdById`'s request. */
	createdByBotId: Schema.NullOr(uuidSchema),
	createdAt: isoTimestampSchema,
	updatedAt: isoTimestampSchema,
});

export type Automation = typeof automationSchema.Type;

/** An automation in the workspace list, with the bot it belongs to. */
export const workspaceAutomationSchema = Schema.Struct({
	automation: automationSchema,
	bot: botSchema,
});

export type WorkspaceAutomation = typeof workspaceAutomationSchema.Type;

/** Every automation on a bot the person can reach, by name. */
export const workspaceAutomationListSchema = Schema.Struct({
	items: Schema.mutable(Schema.Array(workspaceAutomationSchema)),
});

export type WorkspaceAutomationList = typeof workspaceAutomationListSchema.Type;

/**
 * A webhook trigger as written. Without `auth`, a new one takes a bearer
 * token and a changed one keeps how it checks callers. A null `secret` leaves
 * it without one, so its address alone runs the automation. Without `secret`,
 * one is made when it first needs one or its auth kind changes, and is
 * returned then. Without `deliveryIdHeader`, a new trigger detects delivery
 * IDs automatically and an edited trigger keeps its current setting.
 * Without `filter`, a new trigger runs every call and an edited trigger
 * keeps its current filter; an empty array removes it.
 */
const webhookTriggerInputSchema = Schema.Struct({
	kind: Schema.Literal("webhook"),
	auth: Schema.optional(webhookAuthSchema),
	deliveryIdHeader: webhookDeliveryIdHeaderSchema,
	filter: Schema.optional(webhookFilterSchema),
	secret: Schema.optional(Schema.NullOr(webhookSecretSchema)),
	schedule: Schema.optional(Schema.Never),
	timezone: Schema.optional(Schema.Never),
});

const scheduledTriggerInputSchema = Schema.Struct({
	kind: Schema.Literal("schedule"),
	schedule: automationScheduleSchema,
	timezone: timezoneSchema,
});

const gitHubTriggerInputSchema = Schema.Struct({
	kind: Schema.Literal("github"),
	...gitHubTriggerFields,
});

/** A trigger as written, to add to an automation or to replace one of its own of the same kind. */
export const automationTriggerInputSchema = Schema.Union([
	scheduledTriggerInputSchema,
	webhookTriggerInputSchema,
	gitHubTriggerInputSchema,
]);

export type AutomationTriggerInput = typeof automationTriggerInputSchema.Type;

/** At most this many triggers start one automation. */
export const MAX_AUTOMATION_TRIGGERS = 20;

export const newAutomationSchema = Schema.Struct({
	name: automationNameSchema,
	instructions: automationInstructionsSchema,
	state: Schema.optional(automationStateSchema),
	triggers: Schema.Array(automationTriggerInputSchema).check(
		Schema.isMaxLength(MAX_AUTOMATION_TRIGGERS),
	),
});

export type NewAutomation = typeof newAutomationSchema.Type;

/** An automation's own settings; its triggers change one by one, through their own endpoints. */
export const automationUpdateSchema = Schema.Struct({
	name: Schema.optional(automationNameSchema),
	instructions: Schema.optional(automationInstructionsSchema),
	state: Schema.optional(automationStateSchema),
});

export type AutomationUpdate = typeof automationUpdateSchema.Type;

export const runStateSchema = Schema.Literals([
	"queued",
	"running",
	"completed",
	"failed",
	"cancelled",
]);

export type RunState = typeof runStateSchema.Type;

export const runTriggerKindSchema = Schema.Literals(["schedule", "webhook", "github", "manual"]);
export type RunTriggerKind = typeof runTriggerKindSchema.Type;

const jsonValueSchema = Schema.Unknown.check(
	Schema.makeFilter(Schema.is(Schema.Json), { expected: "a JSON value" }),
);

export const runTriggerSchema = Schema.Union([
	Schema.Struct({
		kind: Schema.Literal("schedule"),
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
		/** The comment associated with this run, if any. */
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

export type RunTrigger = typeof runTriggerSchema.Type;

export const runSchema = Schema.Struct({
	id: uuidSchema,
	automationId: uuidSchema,
	workspaceId: uuidSchema,
	botId: uuidSchema,
	/** The run's own conversation. */
	conversationId: uuidSchema,
	/** The automation's feed, which lists the run beside its other runs. */
	rootConversationId: uuidSchema,
	automationName: automationNameSchema,
	instructions: automationInstructionsSchema,
	trigger: runTriggerSchema,
	state: runStateSchema,
	error: Schema.NullOr(Schema.String),
	/**
	 * Whether it posted a result for people to read. A run that completed
	 * without posting one had nothing to report.
	 */
	posted: Schema.Boolean,
	acceptedAt: isoTimestampSchema,
	startedAt: Schema.NullOr(isoTimestampSchema),
	finishedAt: Schema.NullOr(isoTimestampSchema),
});

export type Run = typeof runSchema.Type;

export const runSummarySchema = Schema.Struct({
	runId: uuidSchema,
	automationId: uuidSchema,
	automationName: automationNameSchema,
	triggerKind: runTriggerKindSchema,
	triggeredAt: isoTimestampSchema,
});
export type RunSummary = typeof runSummarySchema.Type;

export const runPageQuerySchema = Schema.Struct({
	cursor: Schema.optional(Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(200))),
	limit: Schema.String.check(Schema.isPattern(/^\d+$/)).pipe(
		Schema.decodeTo(Schema.FiniteFromString),
		Schema.check(Schema.isInt(), Schema.isBetween({ minimum: 1, maximum: MAX_RUN_PAGE_LIMIT })),
		Schema.withDecodingDefault(Effect.succeed(String(DEFAULT_RUN_PAGE_LIMIT))),
	),
});
export type RunPageQuery = typeof runPageQuerySchema.Type;

export const runPageSchema = Schema.Struct({
	items: Schema.mutable(Schema.Array(runSchema)),
	nextCursor: Schema.NullOr(Schema.String),
});
export type RunPage = typeof runPageSchema.Type;

export const automationTriggerAuthorSchema = Schema.Struct({
	kind: Schema.Literal("automation_trigger"),
	runId: uuidSchema,
	automationName: automationNameSchema,
	triggerKind: runTriggerKindSchema,
});

export type AutomationTriggerAuthor = typeof automationTriggerAuthorSchema.Type;

/**
 * The run whose result a message is, in the automation's feed or a channel's conversation:
 * the automation, and the conversation the run's work is in.
 */
export const automationResultOfSchema = Schema.Struct({
	runId: uuidSchema,
	conversationId: uuidSchema,
	automationId: uuidSchema,
	automationName: automationNameSchema,
});

export type AutomationResultOf = typeof automationResultOfSchema.Type;

export const manualAutomationRunSchema = Schema.Struct({ requestId: uuidSchema });
export type ManualAutomationRun = typeof manualAutomationRunSchema.Type;

export const acceptedRunSchema = Schema.Struct({
	runId: uuidSchema,
	conversationId: uuidSchema,
	duplicate: Schema.Boolean,
});

export type AcceptedRun = typeof acceptedRunSchema.Type;

/** A webhook trigger's new secret, or null when it was left without one. */
export const automationSecretSchema = Schema.Struct({ secret: Schema.NullOr(Schema.String) });
export type AutomationSecret = typeof automationSecretSchema.Type;

/**
 * A webhook trigger's current secret, for somebody who manages it. One with
 * `none` runs the automation for anybody who has its address; a `hashed` one has
 * a bearer token made before secrets were kept, which only its hash checks.
 */
export const automationCurrentSecretSchema = Schema.Union([
	Schema.Struct({ kind: Schema.Literal("set"), secret: Schema.String }),
	Schema.Struct({ kind: Schema.Literal("none") }),
	Schema.Struct({ kind: Schema.Literal("hashed") }),
]);
export type AutomationCurrentSecret = typeof automationCurrentSecretSchema.Type;

/**
 * Replaces a webhook trigger's secret with `secret`, with a new one when it
 * is absent, or with none when it is null, so the address alone runs it.
 */
export const automationSecretReplacementSchema = Schema.Struct({
	secret: Schema.optional(Schema.NullOr(webhookSecretSchema)),
});
export type AutomationSecretReplacement = typeof automationSecretReplacementSchema.Type;

/** What a webhook's caller is answered: `executionId` is the run's id, a name callers are documented to read. */
export const acceptedAutomationWebhookSchema = Schema.Struct({
	executionId: uuidSchema,
	duplicate: Schema.Boolean,
});
export type AcceptedAutomationWebhook = typeof acceptedAutomationWebhookSchema.Type;

/** The answer to a call the trigger's filter turned away: no run was started. */
export const ignoredAutomationWebhookSchema = Schema.Struct({ ignored: Schema.Literal(true) });
export type IgnoredAutomationWebhook = typeof ignoredAutomationWebhookSchema.Type;

/** The answer to Slack's check that it may send events to the automation's address. */
export const automationWebhookChallengeSchema = Schema.Struct({ challenge: Schema.String });
export type AutomationWebhookChallenge = typeof automationWebhookChallengeSchema.Type;

/** An automation as written, and the secrets of any webhook triggers the write made one for, shown once. */
export const automationWriteResultSchema = Schema.Struct({
	automation: automationSchema,
	secrets: Schema.Array(Schema.Struct({ triggerId: uuidSchema, secret: Schema.String })),
}).annotate({ identifier: "AutomationWriteResult" });
export type AutomationWriteResult = typeof automationWriteResultSchema.Type;

export const automationSchedulePreviewSchema = Schema.Struct({
	schedule: automationScheduleSchema,
	timezone: timezoneSchema,
});
export type AutomationSchedulePreview = typeof automationSchedulePreviewSchema.Type;

export const automationScheduleOccurrencesSchema = Schema.Array(isoTimestampSchema);
export type AutomationScheduleOccurrences = typeof automationScheduleOccurrencesSchema.Type;
