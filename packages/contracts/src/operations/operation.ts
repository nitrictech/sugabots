export * as OperationContract from "./operation.ts";

import type { DomainError } from "@sugabots/errors";
import type { Schema } from "effect";

/**
 * The public half of an operation: one thing a principal can do, such as
 * `chats.setResolved`. Its body lives in `core/src/operations/`; this half is
 * what every entrypoint and client needs to know, and is safe in the browser.
 */
export interface Contract<
	Name extends string = string,
	InputSchema extends Schema.Top = Schema.Top,
	OutputSchema extends Schema.Top = Schema.Top,
	ErrorSchemas extends ReadonlyArray<ErrorSchema> = ReadonlyArray<ErrorSchema>,
> {
	/** `<domain>.<verb>`, such as `chats.setResolved`. */
	readonly name: Name;
	/**
	 * What it does, in the glossary's words. The bot loop also gives it to the
	 * model as the description of the tool that offers it.
	 */
	readonly description: string;
	readonly input: InputSchema;
	readonly output: OutputSchema;
	/** Every error it can fail with. Each is a `DomainError`, so each has a user message. */
	readonly errors: ErrorSchemas;
	/**
	 * Whether it changes anything. A Personal Assistant asks its person before
	 * any operation that does.
	 */
	readonly changes: boolean;
}

/** An error schema whose values are `DomainError`s, such as a `Schema.TaggedError` class. */
export type ErrorSchema = Schema.Top & { readonly Type: DomainError };

export const make = <
	const Name extends string,
	InputSchema extends Schema.Top,
	OutputSchema extends Schema.Top,
	const ErrorSchemas extends ReadonlyArray<ErrorSchema>,
>(
	name: Name,
	fields: Omit<Contract<Name, InputSchema, OutputSchema, ErrorSchemas>, "name">,
): Contract<Name, InputSchema, OutputSchema, ErrorSchemas> => ({ name, ...fields });

/** The decoded input an operation takes. */
export type Input<Of extends Contract> = Of["input"]["Type"];

/** What an operation returns. */
export type Output<Of extends Contract> = Of["output"]["Type"];

/** The union of the errors an operation can fail with. */
export type Failure<Of extends Contract> = Of["errors"][number]["Type"];
