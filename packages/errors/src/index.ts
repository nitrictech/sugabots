/**
 * Errors the system expects, and the part of each that may be shown outside
 * it: the {@link PublicError}.
 */

import { type Brand, type Cause, Duration, ErrorReporter, type LogLevel, Schema } from "effect";

const userTextSchema = Schema.String.pipe(Schema.brand("UserText"));

/**
 * Text for people to read. Written with {@link userText}, which accepts only
 * our own words and display names, so an exception's message or another
 * service's response can't end up in front of someone.
 */
export type UserText = typeof userTextSchema.Type;

export const UserText = {
	/**
	 * Treats `text` as user text without checking it, for code not yet moved to
	 * `DomainError`. Each call can show people text we didn't write, so review
	 * every one. It goes once the last caller has moved: names become
	 * `DisplayName`s, and the auth library's errors map to our own words.
	 */
	unchecked: (text: string) => text as UserText,
	/**
	 * For an API field that holds user text. Decoding accepts any string, so
	 * decode only responses from our own server.
	 */
	schema: userTextSchema,
};

const displayNameSchema = Schema.String.pipe(Schema.brand("DisplayName"));

/**
 * A name people already see in the app, such as a bot's or a provider's.
 * {@link userText} accepts these.
 */
export type DisplayName = typeof displayNameSchema.Type;

export const DisplayName = {
	/** A name as read from its database record. */
	fromRecord: (name: string) => name as DisplayName,
	/** For a `DomainError` field that holds a display name. */
	schema: displayNameSchema,
};

/**
 * What {@link userText} accepts in a `${}`: user text, a display name, a
 * number, or a fixed word like `"uses" | "use"`. Any other string fails to
 * compile.
 */
type UserTextPart<Part> = Part extends UserText | DisplayName | number
	? Part
	: Part extends Brand.Brand<infer _Keys>
		? never
		: string extends Part
			? never
			: Part;

/**
 * Writes user text: userText`${provider} is switched off.` See
 * {@link UserTextPart} for what can go in a `${}`.
 */
export function userText<const Parts extends ReadonlyArray<string | number>>(
	literals: TemplateStringsArray,
	...parts: { readonly [K in keyof Parts]: UserTextPart<Parts[K]> }
): UserText {
	return literals
		.slice(1)
		.reduce(
			(text, literal, index) => `${text}${parts[index]}${literal}`,
			literals[0] ?? "",
		) as UserText;
}

/**
 * The part of an error that may be shown outside the system. API responses
 * and saved failures use this shape.
 */
export const PublicError = Schema.Struct({
	/** Which error, such as `ProviderDisabled`. */
	_tag: Schema.String,
	/**
	 * What happened and why, what was kept, how to fix it and who can, and what
	 * else the reader can do.
	 */
	userMessage: userTextSchema,
	/** Whether sending the same request again might work. */
	isRetryable: Schema.Boolean,
	/** How long to wait before retrying, if the other side said. */
	retryAfter: Schema.optional(Schema.DurationFromMillis),
});
export type PublicError = typeof PublicError.Type;

/**
 * An error the system expects: the {@link PublicError} fields, plus a
 * `message` and a severity that stay internal.
 *
 * Make one class per failure with `Schema.TaggedError`, named for what went
 * wrong (`ProviderDisabled`, not `ModelError`). If it wraps an error from
 * outside, such as an SDK or database error, give it a `cause:
 * Schema.Defect()` field.
 *
 * Send or save one only through {@link toPublicError}: the class's own schema
 * includes every field, `cause` too.
 */
export interface DomainError extends PublicError, Cause.YieldableError {
	/** For logs only. May include ids, external text and what an operator can do. */
	readonly message: string;
	/** `Info` for a refusal we expect, `Warn` for a failure outside our control. */
	readonly [ErrorReporter.severity]: LogLevel.Severity;
}

const publicFields = Object.keys(PublicError.fields) as ReadonlyArray<keyof PublicError>;

/**
 * The {@link PublicError} fields of `error`. Drops an infinite `retryAfter`,
 * which JSON can't carry.
 */
export function toPublicError<E extends DomainError>(error: E): Pick<E, keyof PublicError> {
	return Object.fromEntries(
		publicFields.flatMap((field) => {
			const value = error[field];
			if (value === undefined) return [];
			if (Duration.isDuration(value) && !Duration.isFinite(value)) return [];
			return [[field, value]];
		}),
	) as Pick<E, keyof PublicError>;
}
