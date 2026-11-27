/**
 * The refusals provers fail with, which any operation that proves access
 * lists among its errors: `Schema.TaggedError` classes implementing
 * `DomainError`.
 */

import { type DomainError, userText } from "@sugabots/errors";
import { ErrorReporter, Schema } from "effect";

/** What a refusal can be about. */
const Resource = Schema.Literals([
	"workspace",
	"membership",
	"invitation",
	"project",
	"chat",
	"message",
	"file",
	"automation",
	"automation trigger",
	"bot",
	"connector",
	"computer",
	"computer provider",
	"turn",
	"approval",
]);

/**
 * Something the principal can't reach, whether or not it exists, so an id
 * can't be probed for. Outside a turn's bounds, it is what the asker would get
 * for something they can't reach, whatever they reach.
 */
export class ResourceHidden
	extends Schema.TaggedError<ResourceHidden>()("ResourceHidden", { resource: Resource })
	implements DomainError
{
	readonly isRetryable = false;
	override readonly [ErrorReporter.severity] = "Info" as const;
	override get message() {
		return `The ${this.resource} is not there, or the principal doesn't reach it`;
	}
	get userMessage() {
		return userText`There's no such ${this.resource}, or you can't see it`;
	}
}

/** Something the principal reaches but may not act on. */
export class ActionForbidden
	extends Schema.TaggedError<ActionForbidden>()("ActionForbidden", {
		/** The proof that was refused, such as `CanManageProject`. */
		proof: Schema.String,
	})
	implements DomainError
{
	readonly isRetryable = false;
	override readonly [ErrorReporter.severity] = "Info" as const;
	override get message() {
		return `Refused ${this.proof}`;
	}
	get userMessage() {
		return userText`You aren't allowed to do that here. Someone who manages it can do it, or let you`;
	}
}

/**
 * Inside a turn's bounds, the asker reaches something the bot doesn't, such
 * as a project the bot was removed from mid-turn. Adding the bot back is the
 * way on, which is why it isn't `ResourceHidden`.
 */
export class BotCannotReach
	extends Schema.TaggedError<BotCannotReach>()("BotCannotReach", { resource: Resource })
	implements DomainError
{
	readonly isRetryable = false;
	override readonly [ErrorReporter.severity] = "Info" as const;
	override get message() {
		return `The asker reaches the ${this.resource}, but the bot doesn't`;
	}
	get userMessage() {
		return userText`This bot can't reach that ${this.resource}, though you can. Add the bot to its project to let it`;
	}
}

/** The turn has already ended, so nothing more is done for it. */
export class TurnEnded
	extends Schema.TaggedError<TurnEnded>()("TurnEnded", {})
	implements DomainError
{
	readonly isRetryable = false;
	override readonly [ErrorReporter.severity] = "Info" as const;
	override get message() {
		return "The turn has ended";
	}
	get userMessage() {
		return userText`This turn has already ended`;
	}
}

/** The call waits for an approver, or for one again, before it may run. */
export class ApprovalNeeded
	extends Schema.TaggedError<ApprovalNeeded>()("ApprovalNeeded", {})
	implements DomainError
{
	readonly isRetryable = false;
	override readonly [ErrorReporter.severity] = "Info" as const;
	override get message() {
		return "The call has no approval that still holds";
	}
	get userMessage() {
		return userText`This needs approval before it runs`;
	}
}

/** The call was denied, its tool was switched off, or it isn't the call that was allowed. */
export class ApprovalRefused
	extends Schema.TaggedError<ApprovalRefused>()("ApprovalRefused", {
		reason: Schema.optional(Schema.Literal("automationsOff")),
	})
	implements DomainError
{
	readonly isRetryable = false;
	override readonly [ErrorReporter.severity] = "Info" as const;
	override get message() {
		return this.reason === "automationsOff"
			? "The bot's automations tool access is Off"
			: "The call was denied, its tool is off, or its arguments differ from those allowed";
	}
	get userMessage() {
		return this.reason === "automationsOff"
			? userText`Automations are off for this bot. Someone who manages the bot can turn them on.`
			: userText`This wasn't allowed, so it didn't run`;
	}
}
