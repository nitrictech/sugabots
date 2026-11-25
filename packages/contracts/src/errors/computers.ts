/**
 * The errors the computers operations can fail with: `Schema.TaggedError` classes
 * implementing `DomainError`.
 */

import { DisplayName, type DomainError, UserText, userText } from "@sugabots/errors";
import { ErrorReporter, Schema } from "effect";

/**
 * The computer provider could not be reached, refused the request, or failed
 * doing it. Core's `Computers.Unavailable` is this class.
 */
export class ComputerUnavailable
	extends Schema.TaggedError<ComputerUnavailable>()("ComputerUnavailable", {
		provider: Schema.String,
		/** What went wrong, when the provider said something members can act on. */
		reason: Schema.optional(UserText.schema),
		cause: Schema.Defect(),
	})
	implements DomainError
{
	readonly isRetryable = true;
	override readonly [ErrorReporter.severity] = "Warn" as const;
	override get message() {
		return `The ${this.provider} computer provider failed`;
	}
	get userMessage() {
		return this.reason ?? userText`The computer provider didn't answer. Try again shortly.`;
	}
}

/** A computer was made while its project or bot was being removed, so nothing was removed. */
export class ComputerMadeMeanwhile
	extends Schema.TaggedError<ComputerMadeMeanwhile>()("ComputerMadeMeanwhile", {})
	implements DomainError
{
	readonly isRetryable = true;
	override readonly [ErrorReporter.severity] = "Info" as const;
	override get message() {
		return "A computer was made while its project was being removed";
	}
	get userMessage() {
		return userText`A computer started meanwhile, so nothing was removed. Try again.`;
	}
}

/** Work on a computer lost its claim before it could finish. */
export class ClaimLost
	extends Schema.TaggedError<ClaimLost>()("ClaimLost", {})
	implements DomainError
{
	readonly isRetryable = true;
	override readonly [ErrorReporter.severity] = "Warn" as const;
	override get message() {
		return "The computer claim expired or changed";
	}
	get userMessage() {
		return userText`Work on the computer changed while this was running. Try again.`;
	}
}

/** The workspace has no computer provider with the id asked for. */
export class ComputerProviderNotFound
	extends Schema.TaggedError<ComputerProviderNotFound>()("ComputerProviderNotFound", {})
	implements DomainError
{
	readonly isRetryable = false;
	override readonly [ErrorReporter.severity] = "Info" as const;
	override get message() {
		return "The workspace has no computer provider with that id";
	}
	get userMessage() {
		return userText`This workspace has no such computer provider`;
	}
}

/** The setting an enabled computer provider lacks: its key, its address, or E2B Embed's two addresses. */
const MissingSetting = Schema.Literals(["key", "address", "addresses"]);

const MISSING_SETTING = {
	key: userText`Add an API key before enabling this provider`,
	address: userText`Add the server's address before enabling this provider`,
	addresses: userText`E2B Embed needs both its API and computer addresses`,
} satisfies Record<typeof MissingSetting.Type, UserText>;

/** Enabling a provider that lacks a setting it needs to make computers. */
export class ComputerProviderIncomplete
	extends Schema.TaggedError<ComputerProviderIncomplete>()("ComputerProviderIncomplete", {
		missing: MissingSetting,
	})
	implements DomainError
{
	readonly isRetryable = false;
	override readonly [ErrorReporter.severity] = "Info" as const;
	override get message() {
		return `The computer provider can't be enabled without its ${this.missing}`;
	}
	get userMessage() {
		return MISSING_SETTING[this.missing];
	}
}

/** Settings for another built-in provider than the provider's, which is fixed when it's made. */
export class ComputerProviderBuiltInFixed
	extends Schema.TaggedError<ComputerProviderBuiltInFixed>()("ComputerProviderBuiltInFixed", {})
	implements DomainError
{
	readonly isRetryable = false;
	override readonly [ErrorReporter.severity] = "Info" as const;
	override get message() {
		return "The settings are for another built-in provider than the computer provider's";
	}
	get userMessage() {
		return userText`A provider's type can't be changed. Add a provider of the other type instead.`;
	}
}

/**
 * The provider's computers couldn't be destroyed, so it was kept: removing it
 * would leave them running at the provider with nothing to remove them.
 * `reason` says whether it lacks the settings to reach them, or didn't answer.
 */
export class ComputersNotDestroyed
	extends Schema.TaggedError<ComputersNotDestroyed>()("ComputersNotDestroyed", {
		reason: Schema.Literals(["incomplete", "unavailable"]),
		cause: Schema.optional(Schema.Defect()),
	})
	implements DomainError
{
	override readonly [ErrorReporter.severity] = "Warn" as const;
	get isRetryable() {
		return this.reason === "unavailable";
	}
	override get message() {
		return this.reason === "incomplete"
			? "The computer provider still has computers, and lacks the settings to destroy them"
			: "The computer provider didn't answer while its computers were destroyed";
	}
	get userMessage() {
		return this.reason === "incomplete"
			? userText`This provider still has computers, and needs its settings to remove them. Restore its key or address, then remove it.`
			: userText`This provider's computers couldn't be removed because it didn't answer. Try again when it's reachable.`;
	}
}

/** The provider takes images as they are, or lacks the settings to build a template with. */
export class NoTemplates
	extends Schema.TaggedError<NoTemplates>()("NoTemplates", {})
	implements DomainError
{
	readonly isRetryable = false;
	override readonly [ErrorReporter.severity] = "Info" as const;
	override get message() {
		return "The computer provider has no template to prepare";
	}
	get userMessage() {
		return userText`This provider has no template to prepare. Add its key first, if it needs one.`;
	}
}

/**
 * The host is blocked for the workspace, so no project may allow it: `by` is
 * the block that covers it, the host itself or a wildcard over it. Core's
 * `ComputerNetwork.HostBlocked` is this class.
 */
export class ComputerHostBlocked
	extends Schema.TaggedError<ComputerHostBlocked>()("ComputerHostBlocked", {
		host: Schema.String,
		by: Schema.String,
	})
	implements DomainError
{
	readonly isRetryable = false;
	override readonly [ErrorReporter.severity] = "Info" as const;
	override get message() {
		return `The host ${this.host} is blocked for the workspace's computers by ${this.by}`;
	}
	get userMessage() {
		// Members read hosts as they were entered in the computer's settings,
		// checked by `computerHostSchema` on the way in.
		const host = DisplayName.fromRecord(this.host);
		return this.by === this.host
			? userText`${host} is blocked for this workspace's computers.`
			: userText`${host} would reach ${DisplayName.fromRecord(this.by)}, which is blocked for this workspace's computers.`;
	}
}

/** A turn is using the computer, and resetting or upgrading it would pull it out from under the project. */
export class ComputerInUse
	extends Schema.TaggedError<ComputerInUse>()("ComputerInUse", {})
	implements DomainError
{
	readonly isRetryable = true;
	override readonly [ErrorReporter.severity] = "Info" as const;
	override get message() {
		return "A turn is using the computer";
	}
	get userMessage() {
		return userText`A bot is using the computer right now. Try again when it has finished.`;
	}
}

/** The project has no computer to upgrade, or its provider lost it. */
export class NoComputer
	extends Schema.TaggedError<NoComputer>()("NoComputer", {})
	implements DomainError
{
	readonly isRetryable = false;
	override readonly [ErrorReporter.severity] = "Info" as const;
	override get message() {
		return "The project has no computer to upgrade";
	}
	get userMessage() {
		return userText`There's no computer to upgrade. Its next one is made from the current image.`;
	}
}

/** An upgrade stopped before the project moved; its old computer is untouched. */
export class UpgradeFailed
	extends Schema.TaggedError<UpgradeFailed>()("UpgradeFailed", {
		/** Why it stopped, in members' words. */
		reason: UserText.schema,
	})
	implements DomainError
{
	readonly isRetryable = true;
	override readonly [ErrorReporter.severity] = "Warn" as const;
	override get message() {
		return `The computer's upgrade stopped: ${this.reason}`;
	}
	get userMessage() {
		return this.reason;
	}
}

/** No computer provider is enabled, so there's nothing to make a new computer with. */
export class NoComputerProvider
	extends Schema.TaggedError<NoComputerProvider>()("NoComputerProvider", {})
	implements DomainError
{
	readonly isRetryable = false;
	override readonly [ErrorReporter.severity] = "Info" as const;
	override get message() {
		return "The workspace has no computer provider enabled";
	}
	get userMessage() {
		return userText`Enable a computer provider in the workspace's settings first.`;
	}
}

/**
 * A bot's desktop in a chat can't be shown: the bot takes no part in the
 * chat, uses no computer, or the workspace's computers are switched off.
 * `reason` says which, in members' words.
 */
export class DesktopUnavailable
	extends Schema.TaggedError<DesktopUnavailable>()("DesktopUnavailable", {
		reason: UserText.schema,
	})
	implements DomainError
{
	readonly isRetryable = false;
	override readonly [ErrorReporter.severity] = "Info" as const;
	override get message() {
		return "The bot's desktop can't be shown";
	}
	get userMessage() {
		return this.reason;
	}
}
