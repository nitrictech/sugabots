/**
 * The errors the automations operations can fail with: `Schema.TaggedError` classes
 * implementing `DomainError`.
 */

import { type DomainError, type UserText, userText } from "@sugabots/errors";
import { ErrorReporter, Schema } from "effect";
import { MAX_AUTOMATION_TRIGGERS, MIN_WEBHOOK_SECRET_CHARACTERS } from "../automations.ts";

export class AutomationNotFound
	extends Schema.TaggedError<AutomationNotFound>()("AutomationNotFound", {})
	implements DomainError
{
	readonly isRetryable = false;
	override readonly [ErrorReporter.severity] = "Info" as const;
	override get message() {
		return "No automation of the project has that id";
	}
	get userMessage() {
		return userText`No such automation`;
	}
}

/** Another automation of the project already has this name. */
export class AutomationNameTaken
	extends Schema.TaggedError<AutomationNameTaken>()("AutomationNameTaken", {})
	implements DomainError
{
	readonly isRetryable = false;
	override readonly [ErrorReporter.severity] = "Info" as const;
	override get message() {
		return "Another automation of the project has that name";
	}
	get userMessage() {
		return userText`An automation with that name already exists`;
	}
}

export class AutomationTriggerConflict
	extends Schema.TaggedError<AutomationTriggerConflict>()("AutomationTriggerConflict", {})
	implements DomainError
{
	readonly isRetryable = false;
	override readonly [ErrorReporter.severity] = "Info" as const;
	override get message() {
		return "A run was already accepted for this trigger identity, with different data";
	}
	get userMessage() {
		return userText`That trigger identity was already used with different data`;
	}
}

export class AutomationTriggerRejected
	extends Schema.TaggedError<AutomationTriggerRejected>()("AutomationTriggerRejected", {})
	implements DomainError
{
	readonly isRetryable = false;
	override readonly [ErrorReporter.severity] = "Info" as const;
	override get message() {
		return "The automation does not take this trigger";
	}
	get userMessage() {
		return userText`That automation cannot accept this trigger`;
	}
}

/** A secret made up for a generic webhook too short to be hard to guess. */
export class WebhookSecretTooShort
	extends Schema.TaggedError<WebhookSecretTooShort>()("WebhookSecretTooShort", {})
	implements DomainError
{
	readonly isRetryable = false;
	override readonly [ErrorReporter.severity] = "Info" as const;
	override get message() {
		return "The webhook secret brought is too short";
	}
	get userMessage() {
		return userText`A secret needs at least ${MIN_WEBHOOK_SECRET_CHARACTERS} characters`;
	}
}

export class WebhookSecretRestricted
	extends Schema.TaggedError<WebhookSecretRestricted>()("WebhookSecretRestricted", {})
	implements DomainError
{
	readonly isRetryable = false;
	override readonly [ErrorReporter.severity] = "Info" as const;
	override get message() {
		return "The webhook secret can only be read by a workspace administrator";
	}
	get userMessage() {
		return userText`Only the workspace owner and admins can see this webhook secret. Anyone who manages the automation can replace it.`;
	}
}

export class WebhookDeliveryIdHeaderRejected
	extends Schema.TaggedError<WebhookDeliveryIdHeaderRejected>()(
		"WebhookDeliveryIdHeaderRejected",
		{},
	)
	implements DomainError
{
	readonly isRetryable = false;
	override readonly [ErrorReporter.severity] = "Info" as const;
	override get message() {
		return "The delivery id header is one the webhook authenticates with";
	}
	get userMessage() {
		return userText`The delivery ID header must be different from an authentication header`;
	}
}

export class AutomationDeliveryIdTooLong
	extends Schema.TaggedError<AutomationDeliveryIdTooLong>()("AutomationDeliveryIdTooLong", {})
	implements DomainError
{
	readonly isRetryable = false;
	override readonly [ErrorReporter.severity] = "Info" as const;
	override get message() {
		return "The webhook delivery's id is longer than a trigger identity may be";
	}
	get userMessage() {
		return userText`The delivery's id is too long`;
	}
}

/** A repository trigger for a repository the automation's project's GitHub app doesn't work on. */
export class AutomationRepositoryNotConnected
	extends Schema.TaggedError<AutomationRepositoryNotConnected>()(
		"AutomationRepositoryNotConnected",
		{},
	)
	implements DomainError
{
	readonly isRetryable = false;
	override readonly [ErrorReporter.severity] = "Info" as const;
	override get message() {
		return "The repository is not one of the project's GitHub connector";
	}
	get userMessage() {
		return userText`That repository isn't one the project's GitHub app works on. Add it to the GitHub app first.`;
	}
}

export class AutomationTriggerNotFound
	extends Schema.TaggedError<AutomationTriggerNotFound>()("AutomationTriggerNotFound", {})
	implements DomainError
{
	readonly isRetryable = false;
	override readonly [ErrorReporter.severity] = "Info" as const;
	override get message() {
		return "The automation has no trigger with that id";
	}
	get userMessage() {
		return userText`The automation has no such trigger. It may have been removed.`;
	}
}

/** A trigger written as another kind than it is: a trigger keeps its kind, and another is added instead. */
export class AutomationTriggerKindChanged
	extends Schema.TaggedError<AutomationTriggerKindChanged>()("AutomationTriggerKindChanged", {})
	implements DomainError
{
	readonly isRetryable = false;
	override readonly [ErrorReporter.severity] = "Info" as const;
	override get message() {
		return "A trigger was written as another kind than it is";
	}
	get userMessage() {
		return userText`A trigger keeps its kind. Add a trigger of the other kind instead, and remove this one.`;
	}
}

export class TooManyAutomationTriggers
	extends Schema.TaggedError<TooManyAutomationTriggers>()("TooManyAutomationTriggers", {})
	implements DomainError
{
	readonly isRetryable = false;
	override readonly [ErrorReporter.severity] = "Info" as const;
	override get message() {
		return `The automation already has ${MAX_AUTOMATION_TRIGGERS} triggers`;
	}
	get userMessage() {
		return userText`An automation can have at most ${MAX_AUTOMATION_TRIGGERS} triggers.`;
	}
}

/** Why a routine's timetable cannot run. */
const ScheduleProblem = Schema.Literals([
	"notFiveFields",
	"unknownTimeZone",
	"unparseable",
	"neverRuns",
]);

const SCHEDULE_PROBLEM_USER_MESSAGES: Record<typeof ScheduleProblem.Type, UserText> = {
	notFiveFields: userText`Use a five-field cron expression`,
	unknownTimeZone: userText`That time zone is not recognised`,
	unparseable: userText`That cron expression is invalid`,
	neverRuns: userText`That timetable never runs`,
};

/** A routine's timetable that cannot run. Members are told what to fix in our words, not the cron parser's. */
export class InvalidRoutineSchedule
	extends Schema.TaggedError<InvalidRoutineSchedule>()("InvalidRoutineSchedule", {
		reason: ScheduleProblem,
		/** What the cron parser threw, when it refused the expression. */
		cause: Schema.optional(Schema.Defect()),
	})
	implements DomainError
{
	readonly isRetryable = false;
	override readonly [ErrorReporter.severity] = "Info" as const;
	override get message() {
		return `Invalid routine timetable: ${this.reason}`;
	}
	get userMessage() {
		return SCHEDULE_PROBLEM_USER_MESSAGES[this.reason];
	}
}

/**
 * A webhook call that isn't signed with its webhook's secret, is addressed to
 * no webhook, or to one whose automation is paused or deleted, which are
 * answered alike so an address can't be probed for. A GitHub app's webhook
 * refuses an unsigned delivery with it too.
 */
export class WebhookRefused
	extends Schema.TaggedError<WebhookRefused>()("WebhookRefused", {})
	implements DomainError
{
	readonly isRetryable = false;
	override readonly [ErrorReporter.severity] = "Info" as const;
	override get message() {
		return "A webhook call named no webhook, or failed its webhook's check";
	}
	get userMessage() {
		return userText`This webhook call wasn't accepted. Check its address and its secret`;
	}
}

/**
 * A routine changed only while it is all that starts its automation, as a bot
 * changes one: one with another routine or a trigger has those set up in
 * settings.
 */
export class TriggerSetInSettings
	extends Schema.TaggedError<TriggerSetInSettings>()("TriggerSetInSettings", {})
	implements DomainError
{
	readonly isRetryable = false;
	override readonly [ErrorReporter.severity] = "Info" as const;
	override get message() {
		return "The automation has another routine or a trigger, set up in settings";
	}
	get userMessage() {
		return userText`That automation has more than one routine, or a trigger, which only its Automations page can change. Its name, instructions and whether it is paused can still be changed here.`;
	}
}
