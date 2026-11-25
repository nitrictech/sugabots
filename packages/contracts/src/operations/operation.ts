export * as OperationContract from "./operation.ts";

import type { DomainError } from "@sugabots/errors";
import type { Schema } from "effect";

/**
 * How an operation runs.
 *
 * - `request`: once per call, returning one output.
 * - `longRunning`: a stream or the desktop viewer, which lasts as long as its
 *   caller follows it. It proves access when it starts, keeps only ids, and
 *   proves again, with its values named afresh, each time who reaches what
 *   changes; it ends once it is refused, or its session ends or expires. Its
 *   output is what it yields while it runs, one at a time.
 */
export type Kind = "request" | "longRunning";

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
	RunsAs extends Kind = Kind,
> {
	/** `<domain>.<verb>`, such as `chats.setResolved`. */
	readonly name: Name;
	readonly kind: RunsAs;
	/**
	 * What it does, in the glossary's words. The bot loop also gives it to the
	 * model as the description of the tool that offers it.
	 */
	readonly description: string;
	readonly input: InputSchema;
	/** What it returns; for a long-running operation, each thing it yields while it runs. */
	readonly output: OutputSchema;
	/** Every error it can fail with. Each is a `DomainError`, so each has a user message. */
	readonly errors: ErrorSchemas;
	/**
	 * Whether it changes anything. A Personal Assistant asks its member before
	 * any operation that does.
	 */
	readonly changes: boolean;
}

/** An error schema whose values are `DomainError`s, such as a `Schema.TaggedError` class. */
type ErrorSchema = Schema.Top & { readonly Type: DomainError };

/** The contract of an operation that runs once per call. */
export const make = <
	const Name extends string,
	InputSchema extends Schema.Top,
	OutputSchema extends Schema.Top,
	const ErrorSchemas extends ReadonlyArray<ErrorSchema>,
>(
	name: Name,
	fields: Omit<Contract<Name, InputSchema, OutputSchema, ErrorSchemas>, "name" | "kind">,
): Contract<Name, InputSchema, OutputSchema, ErrorSchemas, "request"> => ({
	name,
	kind: "request",
	...fields,
});

/**
 * The contract of a long-running operation (see {@link Kind}). It changes
 * nothing: following something only reads it.
 */
export const makeLongRunning = <
	const Name extends string,
	InputSchema extends Schema.Top,
	OutputSchema extends Schema.Top,
	const ErrorSchemas extends ReadonlyArray<ErrorSchema>,
>(
	name: Name,
	fields: Omit<
		Contract<Name, InputSchema, OutputSchema, ErrorSchemas>,
		"name" | "kind" | "changes"
	>,
): Contract<Name, InputSchema, OutputSchema, ErrorSchemas, "longRunning"> => ({
	name,
	kind: "longRunning",
	changes: false,
	...fields,
});

/** The decoded input an operation takes. */
export type Input<Of extends Contract> = Of["input"]["Type"];

/** What an operation returns. */
export type Output<Of extends Contract> = Of["output"]["Type"];

/** The union of the errors an operation can fail with. */
export type Failure<Of extends Contract> = Of["errors"][number]["Type"];
