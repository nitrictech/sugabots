/**
 * The errors the workspace operations can fail with: `Schema.TaggedError` classes
 * implementing `DomainError`.
 */

import { DisplayName, type DomainError, userText } from "@sugabots/errors";
import { ErrorReporter, Schema } from "effect";

/** Another workspace has the address. */
export class SlugTaken
	extends Schema.TaggedError<SlugTaken>()("SlugTaken", {})
	implements DomainError
{
	readonly isRetryable = false;
	override readonly [ErrorReporter.severity] = "Info" as const;
	override get message() {
		return "Another workspace has the address";
	}
	get userMessage() {
		return userText`That address is taken by another workspace`;
	}
}

/** The API reads a UUID-shaped workspace reference as an id, so such a slug would be unreachable. */
export class SlugShapedLikeUuid
	extends Schema.TaggedError<SlugShapedLikeUuid>()("SlugShapedLikeUuid", {})
	implements DomainError
{
	readonly isRetryable = false;
	override readonly [ErrorReporter.severity] = "Info" as const;
	override get message() {
		return "The workspace address is shaped like a UUID";
	}
	get userMessage() {
		return userText`A workspace address cannot be shaped like a UUID`;
	}
}

/**
 * Postgres does not have the time zone, though the API's own check passed:
 * their time zone databases can differ. Every day and month in the workspace
 * is worked out in Postgres, so it has to know the zone.
 */
export class TimeZoneUnknown
	extends Schema.TaggedError<TimeZoneUnknown>()("TimeZoneUnknown", {})
	implements DomainError
{
	readonly isRetryable = false;
	override readonly [ErrorReporter.severity] = "Info" as const;
	override get message() {
		return "Postgres, or the automations' runtime, doesn't know the time zone";
	}
	get userMessage() {
		return userText`That time zone isn't one the server knows`;
	}
}

/** The owner cannot leave: ownership has to be handed on first. */
export class OwnerStays
	extends Schema.TaggedError<OwnerStays>()("OwnerStays", {})
	implements DomainError
{
	readonly isRetryable = false;
	override readonly [ErrorReporter.severity] = "Info" as const;
	override get message() {
		return "The owner stays until they hand ownership over";
	}
	get userMessage() {
		return userText`The owner stays until they hand ownership over to somebody else`;
	}
}

/** Somebody with the invited address is in the workspace already. */
export class AlreadyInWorkspace
	extends Schema.TaggedError<AlreadyInWorkspace>()("AlreadyInWorkspace", {})
	implements DomainError
{
	readonly isRetryable = false;
	override readonly [ErrorReporter.severity] = "Info" as const;
	override get message() {
		return "A member with the invited address is in the workspace";
	}
	get userMessage() {
		return userText`They are already in this workspace`;
	}
}

/** An invitation to the address is pending, and this one isn't sent again. */
export class AlreadyInvited
	extends Schema.TaggedError<AlreadyInvited>()("AlreadyInvited", {})
	implements DomainError
{
	readonly isRetryable = false;
	override readonly [ErrorReporter.severity] = "Info" as const;
	override get message() {
		return "An invitation to the address is pending";
	}
	get userMessage() {
		return userText`They have already been invited`;
	}
}

/** The invitation is addressed to the member, whose account hasn't proved the address yet. */
export class EmailUnverified
	extends Schema.TaggedError<EmailUnverified>()("EmailUnverified", {})
	implements DomainError
{
	readonly isRetryable = false;
	override readonly [ErrorReporter.severity] = "Info" as const;
	override get message() {
		return "The invitee's account hasn't verified its email address";
	}
	get userMessage() {
		return userText`Verify your email address before accepting this invitation`;
	}
}

const LIST = new Intl.ListFormat("en", { type: "conjunction" });

/**
 * Model providers sign in with the subscription of a member being removed
 * from the workspace, or leaving it. Signing them out would stop the bots and
 * the default model that run on them, so the member stays until each is
 * signed in by another member or switched to a key.
 */
export class SubscriptionInUse
	extends Schema.TaggedError<SubscriptionInUse>()("SubscriptionInUse", {
		member: DisplayName.schema,
		/** In the order the workspace's list of model providers shows them. */
		providers: Schema.Array(DisplayName.schema),
	})
	implements DomainError
{
	readonly isRetryable = false;
	override readonly [ErrorReporter.severity] = "Info" as const;
	override get message() {
		return `${this.member} stays in the workspace: ${LIST.format(this.providers)} sign in with their subscription`;
	}
	get userMessage() {
		const one = this.providers.length === 1;
		// A list of names members see is itself a name they see.
		const names = DisplayName.fromRecord(LIST.format(this.providers));
		return userText`${names} ${one ? "signs" : "sign"} in with ${this.member}'s subscription, so ${this.member} stays until another member signs ${one ? "it" : "them"} in or ${one ? "it's" : "they're"} switched to a key.`;
	}
}

/** The bot named is not one this member may finish workspace setup with. */
export class NotReadyToFinish
	extends Schema.TaggedError<NotReadyToFinish>()("NotReadyToFinish", {})
	implements DomainError
{
	readonly isRetryable = false;
	override readonly [ErrorReporter.severity] = "Info" as const;
	override get message() {
		return "The bot named isn't one the member made in the workspace";
	}
	get userMessage() {
		return userText`Finish creating your bot first`;
	}
}

/** The first bot runs on no model, or on one the workspace does not offer. */
export class NoModelChosen
	extends Schema.TaggedError<NoModelChosen>()("NoModelChosen", {})
	implements DomainError
{
	readonly isRetryable = false;
	override readonly [ErrorReporter.severity] = "Info" as const;
	override get message() {
		return "The first bot runs on no model the workspace offers";
	}
	get userMessage() {
		return userText`Choose a model for your first bot first`;
	}
}

/** The server doesn't sign members up by referral, so nobody has a referral link. */
export class ReferralsOff
	extends Schema.TaggedError<ReferralsOff>()("ReferralsOff", {})
	implements DomainError
{
	readonly isRetryable = false;
	override readonly [ErrorReporter.severity] = "Info" as const;
	override get message() {
		return "Sign-up isn't by referral on this server";
	}
	get userMessage() {
		return userText`This server does not sign members up by referral.`;
	}
}
