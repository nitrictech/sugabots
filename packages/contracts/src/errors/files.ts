import { type DomainError, userText } from "@sugabots/errors";
import { ErrorReporter, Schema } from "effect";
import { writtenFileKindSchema } from "../files.ts";

export class FileStale
	extends Schema.TaggedError<FileStale>()("FileStale", {
		currentVersion: Schema.Int,
	})
	implements DomainError
{
	readonly isRetryable = false;
	override readonly [ErrorReporter.severity] = "Info" as const;
	get userMessage() {
		return userText`The file is at version ${this.currentVersion} now. Read it again and base your change on that.`;
	}
}

export class FileKindFixed
	extends Schema.TaggedError<FileKindFixed>()("FileKindFixed", {
		kind: writtenFileKindSchema,
	})
	implements DomainError
{
	readonly isRetryable = false;
	override readonly [ErrorReporter.severity] = "Info" as const;
	get userMessage() {
		return userText`The file's kind is ${this.kind}. Leave out fileId to create a file of another kind.`;
	}
}

export class FileContentTooLarge
	extends Schema.TaggedError<FileContentTooLarge>()("FileContentTooLarge", {
		maxCharacters: Schema.Int,
	})
	implements DomainError
{
	readonly isRetryable = false;
	override readonly [ErrorReporter.severity] = "Info" as const;
	get userMessage() {
		return userText`The file would exceed ${this.maxCharacters} characters. Shorten it or split it into more than one file.`;
	}
}

export class FileEditTextUnmatched
	extends Schema.TaggedError<FileEditTextUnmatched>()("EditTextUnmatched", {
		matches: Schema.Int,
	})
	implements DomainError
{
	readonly isRetryable = false;
	override readonly [ErrorReporter.severity] = "Info" as const;
	get userMessage() {
		return this.matches === 0
			? userText`oldText isn't in the file. Read it again and quote its text exactly.`
			: userText`oldText appears ${this.matches} times. Quote more around the change so it appears once.`;
	}
}

export class InvalidFileWrite
	extends Schema.TaggedError<InvalidFileWrite>()("InvalidFileWrite", {
		missing: Schema.Literals(["kindAndTitle", "baseVersion"]),
	})
	implements DomainError
{
	readonly isRetryable = false;
	override readonly [ErrorReporter.severity] = "Info" as const;
	get userMessage() {
		return this.missing === "kindAndTitle"
			? userText`A new file needs a kind and a title.`
			: userText`Changing a file needs the baseVersion you read or last wrote. Use file_read to find it.`;
	}
}
