/**
 * The errors the chats operations can fail with: `Schema.TaggedError` classes
 * implementing `DomainError`.
 */

import { type DomainError, userText } from "@sugabots/errors";
import { ErrorReporter, Schema } from "effect";

/** A retry key was used again in the same destination with a different message. */
export class MessageRetryKeyConflict
	extends Schema.TaggedError<MessageRetryKeyConflict>()("MessageRetryKeyConflict", {})
	implements DomainError
{
	readonly isRetryable = false;
	override readonly [ErrorReporter.severity] = "Info" as const;
	override get message() {
		return "A message retry key was reused for a different message";
	}
	get userMessage() {
		return userText`That retry key is already used by a different message`;
	}
}

/** A reply quoted a message that is not in its chat. */
export class ReplyTargetNotFound
	extends Schema.TaggedError<ReplyTargetNotFound>()("ReplyTargetNotFound", {})
	implements DomainError
{
	readonly isRetryable = false;
	override readonly [ErrorReporter.severity] = "Info" as const;
	override get message() {
		return "A reply quoted a message that is not in its chat";
	}
	get userMessage() {
		return userText`The message you replied to isn't in this chat`;
	}
}

/** A bot given the floor has no model, so nothing was posted for it to answer. */
export class BotHasNoModel
	extends Schema.TaggedError<BotHasNoModel>()("BotHasNoModel", {})
	implements DomainError
{
	readonly isRetryable = false;
	override readonly [ErrorReporter.severity] = "Info" as const;
	override get message() {
		return "A bot given the floor has no model";
	}
	get userMessage() {
		return userText`This bot has no model chosen, so it can't answer yet`;
	}
}

/**
 * A file to send is not one of the author's unsent attachments, such as one cleared
 * for waiting too long. A domain error, so a client can tell it apart by its
 * tag rather than its wording.
 */
export class UnsentAttachmentsNotFound
	extends Schema.TaggedError<UnsentAttachmentsNotFound>()("UnsentAttachmentsNotFound", {})
	implements DomainError
{
	readonly isRetryable = false;
	override readonly [ErrorReporter.severity] = "Info" as const;
	override get message() {
		return "A file to send is not one of the author's unsent attachments";
	}
	get userMessage() {
		return userText`A file to send is no longer there. Remove it and attach it again`;
	}
}

/** A reaction was added to a reply still being written. */
export class MessageNotFinished
	extends Schema.TaggedError<MessageNotFinished>()("MessageNotFinished", {})
	implements DomainError
{
	readonly isRetryable = false;
	override readonly [ErrorReporter.severity] = "Info" as const;
	override get message() {
		return "A reaction was added to a message that is not finished";
	}
	get userMessage() {
		return userText`You can react once the message is finished`;
	}
}

/** A message already has as many different reaction emoji as it can take. */
export class TooManyReactionEmoji
	extends Schema.TaggedError<TooManyReactionEmoji>()("TooManyReactionEmoji", {})
	implements DomainError
{
	readonly isRetryable = false;
	override readonly [ErrorReporter.severity] = "Info" as const;
	override get message() {
		return "A message already has as many different reaction emoji as it can";
	}
	get userMessage() {
		return userText`This message has as many different reactions as it can take. React with one already on it`;
	}
}

/** A file is larger than `maxSize` bytes, the most that is kept. */
export class FileTooLarge
	extends Schema.TaggedError<FileTooLarge>()("FileTooLarge", {
		/** The largest size kept, in bytes. */
		maxSize: Schema.Int,
	})
	implements DomainError
{
	readonly isRetryable = false;
	override readonly [ErrorReporter.severity] = "Info" as const;
	override get message() {
		return `A file was larger than ${this.maxSize} bytes, the most kept`;
	}
	get userMessage() {
		const { amount, unit } = sizeForMembers(this.maxSize);
		return userText`The file is larger than ${amount} ${unit}, the most that can be kept`;
	}
}

/** The uploader already has `maxUnsent` attachments in the chat waiting to be sent. */
export class TooManyUnsentAttachments
	extends Schema.TaggedError<TooManyUnsentAttachments>()("TooManyUnsentAttachments", {
		/** How many unsent attachments one member may have in a chat. */
		maxUnsent: Schema.Int,
	})
	implements DomainError
{
	readonly isRetryable = false;
	override readonly [ErrorReporter.severity] = "Info" as const;
	override get message() {
		return `An uploader already had ${this.maxUnsent} unsent attachments in the chat`;
	}
	get userMessage() {
		return userText`You can have ${this.maxUnsent} files waiting to be sent at most. Send or remove some first`;
	}
}

/** The upload's body stopped before the whole file arrived, so nothing was kept. */
export class UploadInterrupted
	extends Schema.TaggedError<UploadInterrupted>()("UploadInterrupted", {})
	implements DomainError
{
	readonly isRetryable = true;
	override readonly [ErrorReporter.severity] = "Info" as const;
	override get message() {
		return "An upload's body ended before the whole file arrived";
	}
	get userMessage() {
		return userText`The upload was interrupted`;
	}
}

/** `bytes` as members read a file's size, such as 30 MB or 512 KB. */
function sizeForMembers(bytes: number): { amount: number; unit: "MB" | "KB" } {
	const mebibytes = bytes / (1024 * 1024);
	return mebibytes >= 1
		? { amount: Math.floor(mebibytes), unit: "MB" }
		: { amount: Math.max(1, Math.floor(bytes / 1024)), unit: "KB" };
}
