import { Effect, Schema } from "effect";
import isISO8601 from "validator/lib/isISO8601.js";
import { repositoryEventSchema, repositoryPathSchema } from "./github.ts";
import { anyJsonSchema } from "./json.ts";
import { timeZoneSchema } from "./time-zones.ts";
import { isoTimestampSchema } from "./timestamps.ts";
import { uuidSchema } from "./uuid.ts";

export const MAX_AUTOMATION_NAME_CHARACTERS = 80;
export const MAX_AUTOMATION_INSTRUCTIONS_CHARACTERS = 20_000;
export const MAX_CRON_EXPRESSION_CHARACTERS = 200;
export const MAX_IDEMPOTENCY_KEY_CHARACTERS = 200;
export const MAX_ROUTINE_TIMES = 8;
export const MAX_EVERY_DAYS = 30;
export const MAX_EVERY_WEEKS = 12;
export const MAX_EVERY_MONTHS = 12;
const MINUTES_PER_DAY = 24 * 60;
const MAX_WEBHOOK_HEADER_CHARACTERS = 100;
const MAX_WEBHOOK_USERNAME_CHARACTERS = 100;
export const MAX_WEBHOOK_FILTER_TESTS = 10;
export const MAX_WEBHOOK_FILTER_VALUES = 20;
export const MAX_WEBHOOK_FILTER_TEXT_CHARACTERS = 200;
export const MIN_WEBHOOK_SECRET_CHARACTERS = 16;
const MAX_WEBHOOK_SECRET_CHARACTERS = 500;
export const DEFAULT_RUN_PAGE_LIMIT = 20;
const MAX_RUN_PAGE_LIMIT = 100;

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

export const automationStateSchema = Schema.Literals(["enabled", "paused"]);
export type AutomationState = typeof automationStateSchema.Type;

const automationTriggerKindSchema = Schema.Literals(["routine", "webhook", "github"]);
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
 * Webhook sources: the callers whose own way of signing is known, so an automation they call needs
 * only the signing secret they make: GitHub, Stripe, Slack, and Linear,
 * which signs Standard Webhooks.
 */
export const WEBHOOK_SOURCES = ["github", "stripe", "slack", "linear"] as const;
export type WebhookSource = (typeof WEBHOOK_SOURCES)[number];

const webhookHmacAlgorithmSchema = Schema.Literals(["sha1", "sha256", "sha512"]);
export type WebhookHmacAlgorithm = typeof webhookHmacAlgorithmSchema.Type;

const webhookSignatureEncodingSchema = Schema.Literals(["hex", "base64"]);
export type WebhookSignatureEncoding = typeof webhookSignatureEncodingSchema.Type;

/**
 * How a webhook trigger's caller proves it holds the trigger's secret: as a
 * webhook source signs, or, for any other caller, one of the generic kinds.
 * `hmac` signs the raw body with the secret using `algorithm` and sends the
 * digest in `header`, written in `encoding`, optionally after the
 * algorithm's name (`sha256=`). The others send the secret itself.
 */
const webhookAuthSchema = Schema.Union([
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

/** The delivery ID header a new generic webhook reads unless it is given another. */
export const DEFAULT_DELIVERY_ID_HEADER = "Idempotency-Key";

/** The header holding a generic webhook's delivery ID, or null when every call runs. */
const webhookDeliveryIdHeaderSchema = Schema.NullOr(webhookHeaderSchema);

export const AUTOMATIC_DELIVERY_ID = { kind: "automatic" } as const;
const webhookDeliveryIdHeaderInputSchema = Schema.Union([
	webhookDeliveryIdHeaderSchema,
	Schema.Struct({ kind: Schema.Literal(AUTOMATIC_DELIVERY_ID.kind) }),
]);
export type WebhookDeliveryIdHeaderInput = typeof webhookDeliveryIdHeaderInputSchema.Type;

/**
 * A test of a webhook call's JSON body: the text at `path`, keys joined by
 * dots, is one of `oneOf`. Arrays on the way are searched, so
 * `data.labels.name` is met by any label with the name. Numbers and
 * booleans are compared as the text they print as.
 */
export const webhookFilterTestSchema = Schema.Struct({
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
export type WebhookFilterTest = typeof webhookFilterTestSchema.Type;

/**
 * What a webhook trigger requires of a call before it starts a run: every
 * test must pass. A call that fails one is answered but runs nothing.
 * With none, every call runs.
 */
const webhookFilterSchema = Schema.Array(webhookFilterTestSchema).check(
	Schema.isMaxLength(MAX_WEBHOOK_FILTER_TESTS),
);

/**
 * What marks the secrets made for each kind, so members can tell them apart.
 * Basic's password has none, and nor does a webhook source's, which the source makes.
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
const webhookSecretSchema = Schema.Trim.check(
	Schema.isMinLength(1),
	Schema.isMaxLength(MAX_WEBHOOK_SECRET_CHARACTERS),
);

/**
 * Whether `secret` is long enough for a webhook checked by `kind`. A webhook source's
 * secret is the one the source made, however long that is; one made up for
 * a generic webhook needs `MIN_WEBHOOK_SECRET_CHARACTERS`, to be hard to guess.
 */
export function webhookSecretLongEnough(kind: WebhookAuthKind, secret: string): boolean {
	const madeBySource = (WEBHOOK_SOURCES as readonly string[]).includes(kind);
	return madeBySource || secret.trim().length >= MIN_WEBHOOK_SECRET_CHARACTERS;
}

const minutesPastMidnightSchema = Schema.Int.check(
	Schema.isBetween({ minimum: 0, maximum: MINUTES_PER_DAY - 1 }),
);

/** The times of day a routine runs at, by its timetable, as minutes past midnight, each once. */
const scheduleTimesSchema = Schema.Array(minutesPastMidnightSchema).check(
	Schema.isMinLength(1),
	Schema.isMaxLength(MAX_ROUTINE_TIMES),
	Schema.makeFilter((times: readonly number[]) => new Set(times).size === times.length, {
		expected: "each time once",
	}),
);

const weekdaySchema = Schema.Literals(["mon", "tue", "wed", "thu", "fri", "sat", "sun"]);
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
 * When a routine runs, in its time zone: every `every` days, weeks
 * or months counted from `startsOn`, at each of `times`; on `days` of those
 * weeks, or on `dayOfMonth` of those months. A `cron` timetable is a cron
 * expression kept as it was written: a bot writes its routines that way.
 */
export const routineSchema = Schema.Union([
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
export type Routine = typeof routineSchema.Type;

/** A routine's timetable picked by its parts rather than written as cron. */
export type CalendarSchedule = Exclude<Routine, { repeat: "cron" }>;

/**
 * A GitHub trigger's connector, the GitHub app of the automation's project,
 * the repository there it watches, and the events there that start a run.
 */
const gitHubTriggerFields = {
	connectorId: uuidSchema,
	repository: repositoryPathSchema,
	events: Schema.Array(repositoryEventSchema).check(Schema.isMinLength(1)),
};

/** One of the routines and triggers that start an automation; an automation may have several, of any kinds. */
const automationTriggerSchema = Schema.Union([
	Schema.Struct({
		id: uuidSchema,
		kind: Schema.Literal("routine"),
		schedule: routineSchema,
		timezone: timeZoneSchema,
		/** Null while the automation is paused. */
		nextScheduledAt: Schema.NullOr(isoTimestampSchema),
	}),
	Schema.Struct({
		id: uuidSchema,
		kind: Schema.Literal("webhook"),
		auth: webhookAuthSchema,
		/** Absent when a generic webhook detects delivery IDs automatically. */
		deliveryIdHeader: Schema.optional(webhookDeliveryIdHeaderSchema),
		/** Left out while there is none. */
		filter: Schema.optional(webhookFilterSchema),
	}),
	Schema.Struct({ id: uuidSchema, kind: Schema.Literal("github"), ...gitHubTriggerFields }),
]);

export type AutomationTrigger = typeof automationTriggerSchema.Type;

/** A GitHub automation's connector, repository and the events there that run it. */
export type GitHubTrigger = Omit<Extract<AutomationTrigger, { kind: "github" }>, "kind" | "id">;

export const automationSchema = Schema.Struct({
	id: uuidSchema,
	workspaceId: uuidSchema,
	/** The project it belongs to, whose lead bot runs it: for a bot's own, its default project. */
	projectId: uuidSchema,
	name: automationNameSchema,
	instructions: automationInstructionsSchema,
	/** What starts it, in the order they were added; with none, it runs only when someone runs it. */
	triggers: Schema.Array(automationTriggerSchema),
	state: automationStateSchema,
	/** It paused itself after its runs kept failing, and nobody has turned it on or off since. */
	pausedAfterFailures: Schema.Boolean,
	createdById: Schema.NullOr(uuidSchema),
	createdAt: isoTimestampSchema,
	updatedAt: isoTimestampSchema,
});

export type Automation = typeof automationSchema.Type;

/**
 * A webhook trigger as written. Without `auth`, a new one takes a bearer
 * token and a changed one keeps how it checks callers. A null `secret` leaves
 * it without one, so its address alone runs the automation. Without `secret`,
 * one is made when it first needs one or its auth kind changes, and is
 * returned then. Without `deliveryIdHeader`, a new trigger reads
 * `DEFAULT_DELIVERY_ID_HEADER` and an edited trigger keeps its current one.
 * `{ kind: "automatic" }` checks common delivery ID headers and body fields.
 * Without `filter`, a new trigger runs every call and an edited trigger
 * keeps its current filter; an empty array removes it.
 */
const webhookTriggerInputSchema = Schema.Struct({
	kind: Schema.Literal("webhook"),
	auth: Schema.optional(webhookAuthSchema),
	deliveryIdHeader: Schema.optional(webhookDeliveryIdHeaderInputSchema),
	filter: Schema.optional(webhookFilterSchema),
	secret: Schema.optional(Schema.NullOr(webhookSecretSchema)),
	schedule: Schema.optional(Schema.Never),
	timezone: Schema.optional(Schema.Never),
});

const routineInputSchema = Schema.Struct({
	kind: Schema.Literal("routine"),
	schedule: routineSchema,
	timezone: timeZoneSchema,
});

const gitHubTriggerInputSchema = Schema.Struct({
	kind: Schema.Literal("github"),
	...gitHubTriggerFields,
});

/** A routine or trigger as written, to add to an automation or to replace one of its own of the same kind. */
export const automationTriggerInputSchema = Schema.Union([
	routineInputSchema,
	webhookTriggerInputSchema,
	gitHubTriggerInputSchema,
]);

export type AutomationTriggerInput = typeof automationTriggerInputSchema.Type;

/** At most this many routines and triggers start one automation. */
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

export const runTriggerKindSchema = Schema.Literals(["routine", "webhook", "github", "manual"]);
export type RunTriggerKind = typeof runTriggerKindSchema.Type;

const runTriggerSchema = Schema.Union([
	Schema.Struct({
		kind: Schema.Literal("routine"),
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
		payload: anyJsonSchema,
	}),
	Schema.Struct({
		kind: Schema.Literal("github"),
		connectorId: uuidSchema,
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
		requestedByMemberId: uuidSchema,
		requestId: uuidSchema,
	}),
]);

export type RunTrigger = typeof runTriggerSchema.Type;

export const runSchema = Schema.Struct({
	id: uuidSchema,
	automationId: uuidSchema,
	workspaceId: uuidSchema,
	/** The bot that did the run: its project's lead bot when it started. */
	botId: uuidSchema,
	/** The run's own chat. */
	chatId: uuidSchema,
	/** The automation's feed, which lists the run beside its other runs. */
	rootChatId: uuidSchema,
	automationName: automationNameSchema,
	instructions: automationInstructionsSchema,
	trigger: runTriggerSchema,
	state: runStateSchema,
	error: Schema.NullOr(Schema.String),
	/**
	 * Whether it posted a result for members to read. A run that completed
	 * without posting one had nothing to report.
	 */
	posted: Schema.Boolean,
	acceptedAt: isoTimestampSchema,
	startedAt: Schema.NullOr(isoTimestampSchema),
	finishedAt: Schema.NullOr(isoTimestampSchema),
});

export type Run = typeof runSchema.Type;

/**
 * How a listed automation stands, for whoever may read its runs
 * (`automation.history.read`): left out for anyone else.
 */
export const automationListStatusSchema = Schema.Struct({
	/**
	 * It paused itself after its runs kept failing, or it is enabled and its
	 * latest run failed. One paused by hand is not failing.
	 */
	failing: Schema.Boolean,
	/** Its latest run, by when it was accepted; null until it first runs. */
	latestRun: Schema.NullOr(
		Schema.Struct({
			id: uuidSchema,
			state: runStateSchema,
			/** Whether it posted a result (see `Run.posted`). */
			posted: Schema.Boolean,
			acceptedAt: isoTimestampSchema,
			error: Schema.NullOr(Schema.String),
		}),
	),
});

export type AutomationListStatus = typeof automationListStatusSchema.Type;

/** One of a project's automations as its list shows it: how it is set up, and how it stands. */
const listedAutomationDefinitionSchema = Schema.Struct({
	...automationSchema.fields,
	status: Schema.optionalKey(automationListStatusSchema),
});

export type ListedAutomationDefinition = typeof listedAutomationDefinitionSchema.Type;

const restrictableAutomationSchema = Schema.Struct({
	id: uuidSchema,
	name: automationNameSchema,
	state: automationStateSchema,
	restricted: Schema.Literal(true),
});
export type RestrictableAutomation = typeof restrictableAutomationSchema.Type;

export const automationListItemSchema = Schema.Union([
	listedAutomationDefinitionSchema,
	restrictableAutomationSchema,
]);

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
 * The run whose result a message is, in the automation's feed or a project's chat:
 * the automation, and the chat the run's work is in.
 */
export const automationResultOfSchema = Schema.Struct({
	runId: uuidSchema,
	chatId: uuidSchema,
	automationId: uuidSchema,
	automationName: automationNameSchema,
});

export const manualAutomationRunSchema = Schema.Struct({ requestId: uuidSchema });

export const acceptedRunSchema = Schema.Struct({
	runId: uuidSchema,
	chatId: uuidSchema,
	duplicate: Schema.Boolean,
});

export type AcceptedRun = typeof acceptedRunSchema.Type;

/** A webhook trigger's new secret, or null when it was left without one. */
export const automationSecretSchema = Schema.Struct({ secret: Schema.NullOr(Schema.String) });

/**
 * A webhook trigger's current secret, for somebody who manages it. One with
 * `none` runs the automation for anybody who has its address.
 */
export const automationCurrentSecretSchema = Schema.Union([
	Schema.Struct({ kind: Schema.Literal("set"), secret: Schema.String }),
	Schema.Struct({ kind: Schema.Literal("none") }),
]);
export type AutomationCurrentSecret = typeof automationCurrentSecretSchema.Type;

/**
 * Replaces a webhook trigger's secret with `secret`, with a new one when it
 * is absent, or with none when it is null, so the address alone runs it.
 */
export const automationSecretReplacementSchema = Schema.Struct({
	secret: Schema.optional(Schema.NullOr(webhookSecretSchema)),
});

/** What a webhook's caller is answered: the run it started, and whether an earlier delivery started it. */
export const acceptedAutomationWebhookSchema = Schema.Struct({
	runId: uuidSchema,
	duplicate: Schema.Boolean,
});

/** The answer to a call the trigger's filter turned away: no run was started. */
export const ignoredAutomationWebhookSchema = Schema.Struct({ ignored: Schema.Literal(true) });

/** The answer to Slack's check that it may send events to the automation's address. */
export const automationWebhookChallengeSchema = Schema.Struct({ challenge: Schema.String });
export type AutomationWebhookChallenge = typeof automationWebhookChallengeSchema.Type;

/** An automation as written, and the secrets of any webhook triggers the write made one for, shown once. */
export const automationWriteResultSchema = Schema.Struct({
	automation: automationSchema,
	secrets: Schema.Array(Schema.Struct({ triggerId: uuidSchema, secret: Schema.String })),
}).annotate({ identifier: "AutomationWriteResult" });
export type AutomationWriteResult = typeof automationWriteResultSchema.Type;

export const automationUpdateResultSchema = Schema.Union([
	automationWriteResultSchema,
	Schema.Struct({ automation: restrictableAutomationSchema, secrets: Schema.Tuple([]) }),
]);
