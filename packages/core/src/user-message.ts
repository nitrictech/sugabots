import type { Brand } from "effect";

/**
 * Text written for people to read: stored where they will see it, sent to
 * them, or put in an HTTP response. It is built only from our own words, so
 * an exception's text, a provider's response or a stack trace cannot reach
 * people by accident.
 */
export type UserMessage = Brand.Branded<string, "UserMessage">;

export const UserMessage = {
	/**
	 * Our own words, as a tagged template: UserMessage.of`The reply was
	 * interrupted.` Each interpolated part must be a number, a user message,
	 * or a string whose type names its possible values; a plain `string` is
	 * refused, since it could hold anything.
	 */
	of: <const Parts extends ReadonlyArray<string | number>>(
		literals: TemplateStringsArray,
		...parts: { readonly [K in keyof Parts]: string extends Parts[K] ? never : Parts[K] }
	) =>
		literals
			.slice(1)
			.reduce(
				(text, literal, index) => `${text}${parts[index]}${literal}`,
				literals[0] ?? "",
			) as UserMessage,

	/**
	 * Vouches for text the type cannot prove is fit for people, such as a
	 * name a person chose. Each use is a claim for review to check.
	 */
	unchecked: (text: string) => text as UserMessage,
};

/**
 * A failure that people may be told about. `message` is for the logs and may
 * quote anything, a provider's response included; `userMessage` is the only
 * part people see.
 */
export interface UserFacing {
	readonly message: string;
	readonly userMessage: UserMessage;
}
