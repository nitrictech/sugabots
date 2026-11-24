/**
 * The errors the bots operations can fail with: `Schema.TaggedError` classes
 * implementing `DomainError`.
 */

import { type DomainError, userText } from "@sugabots/errors";
import { ErrorReporter, Schema } from "effect";
import { systemBotKeySchema } from "../bots.ts";
import { isGroupMentionHandle } from "../messages.ts";

/** A bot update that names nothing to change. */
export class EmptyBotUpdate
	extends Schema.TaggedError<EmptyBotUpdate>()("EmptyBotUpdate", {})
	implements DomainError
{
	readonly isRetryable = false;
	override readonly [ErrorReporter.severity] = "Info" as const;
	override get message() {
		return "The bot update names nothing to change";
	}
	get userMessage() {
		return userText`Nothing to change`;
	}
}

/** Another bot in the workspace already has this name or handle. */
export class BotNameTaken
	extends Schema.TaggedError<BotNameTaken>()("BotNameTaken", {
		field: Schema.Literals(["name", "handle"]),
		value: Schema.String,
	})
	implements DomainError
{
	readonly isRetryable = false;
	override readonly [ErrorReporter.severity] = "Info" as const;
	override get message() {
		return `A bot with the ${this.field} "${this.value}" already exists in this workspace`;
	}
	get userMessage() {
		return this.field === "name"
			? userText`Another bot in this workspace already has that name`
			: userText`Another bot in this workspace already has that handle`;
	}
}

/** A handle no bot members make may take: `@here`, `@channel` and every Personal Assistant's. */
export class BotHandleReserved
	extends Schema.TaggedError<BotHandleReserved>()("BotHandleReserved", { handle: Schema.String })
	implements DomainError
{
	readonly isRetryable = false;
	override readonly [ErrorReporter.severity] = "Info" as const;
	override get message() {
		return `"${this.handle}" is a reserved handle`;
	}
	get userMessage() {
		return isGroupMentionHandle(this.handle)
			? userText`@${this.handle} mentions everyone, so it can't be a bot's handle`
			: userText`@personal-assistant is every Personal Assistant's handle, so it can't be another bot's`;
	}
}

/** The bot was deleted before the write reached it. */
export class BotGone
	extends Schema.TaggedError<BotGone>()("BotGone", { botId: Schema.String })
	implements DomainError
{
	readonly isRetryable = false;
	override readonly [ErrorReporter.severity] = "Info" as const;
	override get message() {
		return `No bot with the id "${this.botId}"`;
	}
	get userMessage() {
		return userText`No such bot`;
	}
}

/**
 * System bots are shipped by the product and belong to the workspace. The one
 * thing about one that changes, its model, is set on its own.
 */
export class SystemBotImmutable
	extends Schema.TaggedError<SystemBotImmutable>()("SystemBotImmutable", {})
	implements DomainError
{
	readonly isRetryable = false;
	override readonly [ErrorReporter.severity] = "Info" as const;
	override get message() {
		return "A system bot can't be changed or deleted, only given another model";
	}
	get userMessage() {
		return userText`A system bot is configured for the workspace`;
	}
}

/**
 * The workspace has no row for this system bot. Every workspace is given
 * one when it is created, so this is a fault in the data rather than
 * something a caller can retry.
 */
export class SystemBotMissing
	extends Schema.TaggedError<SystemBotMissing>()("SystemBotMissing", { key: systemBotKeySchema })
	implements DomainError
{
	readonly isRetryable = false;
	override readonly [ErrorReporter.severity] = "Warn" as const;
	override get message() {
		return `The workspace has no row for the ${this.key} system bot`;
	}
	get userMessage() {
		return userText`This workspace has no ${this.key} bot`;
	}
}

/** A Personal Assistant's instructions are written and kept by Sugabots. */
export class AssistantInstructionsManaged
	extends Schema.TaggedError<AssistantInstructionsManaged>()("AssistantInstructionsManaged", {})
	implements DomainError
{
	readonly isRetryable = false;
	override readonly [ErrorReporter.severity] = "Info" as const;
	override get message() {
		return "A Personal Assistant's instructions are Sugabots', not its member's";
	}
	get userMessage() {
		return userText`A Personal Assistant's instructions are kept by Sugabots, so they can't be changed`;
	}
}

/** Sugabots manages a Personal Assistant: its member changes only its name, its avatar and its connectors. */
export class AssistantManaged
	extends Schema.TaggedError<AssistantManaged>()("AssistantManaged", {})
	implements DomainError
{
	readonly isRetryable = false;
	override readonly [ErrorReporter.severity] = "Info" as const;
	override get message() {
		return "Only a Personal Assistant's name, avatar and connectors can be changed";
	}
	get userMessage() {
		return userText`Only a Personal Assistant's name, avatar and connectors can be changed`;
	}
}

/** A Personal Assistant is only ever its member's, so it can't be made public. */
export class AssistantVisibilityFixed
	extends Schema.TaggedError<AssistantVisibilityFixed>()("AssistantVisibilityFixed", {})
	implements DomainError
{
	readonly isRetryable = false;
	override readonly [ErrorReporter.severity] = "Info" as const;
	override get message() {
		return "A Personal Assistant's visibility can't change";
	}
	get userMessage() {
		return userText`A Personal Assistant is only ever yours`;
	}
}
