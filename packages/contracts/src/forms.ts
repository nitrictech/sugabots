import { Schema } from "effect";

/**
 * A form an agent asks people in its thread to fill in: an MCP form-mode
 * elicitation request (MCP specification 2025-11-25, `elicitation/create`),
 * held to that specification's restricted JSON Schema. Every field is a flat
 * primitive: text, a number, a yes or no, or a choice of one or several
 * options. Any field may carry a `default`, which prefills it.
 *
 * The limits on counts and lengths are Sugabots' own; the shapes are MCP's.
 */

export const MAX_FORM_FIELDS = 30;
export const MAX_FORM_OPTIONS = 50;
export const MAX_FORM_MESSAGE_CHARACTERS = 2_000;
/** The longest text answer any field takes, and the default `maxLength` of one that sets none. */
export const MAX_FORM_TEXT_ANSWER_CHARACTERS = 10_000;

const FIELD_NAME_PATTERN = /^[A-Za-z0-9_-]{1,64}$/;

const title = Schema.optional(Schema.String.check(Schema.isMaxLength(200)));
const description = Schema.optional(Schema.String.check(Schema.isMaxLength(1_000)));
const optionValue = Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(500));
const length = Schema.optional(Schema.Int.check(Schema.isGreaterThanOrEqualTo(0)));
const count = Schema.optional(Schema.Int.check(Schema.isGreaterThanOrEqualTo(0)));

const untitledOptions = Schema.Array(optionValue).check(
	Schema.isMinLength(1),
	Schema.isMaxLength(MAX_FORM_OPTIONS),
	Schema.isUnique(),
);

const titledOptions = Schema.Array(
	Schema.Struct({ const: optionValue, title: Schema.String.check(Schema.isMaxLength(200)) }),
).check(Schema.isMinLength(1), Schema.isMaxLength(MAX_FORM_OPTIONS));

export const formStringFormatSchema = Schema.Literals(["email", "uri", "date", "date-time"]);

export type FormStringFormat = typeof formStringFormatSchema.Type;

/** A choice of one option, given as bare values. */
const singleSelectSchema = Schema.Struct({
	type: Schema.Literal("string"),
	title,
	description,
	enum: untitledOptions,
	default: Schema.optional(Schema.String),
});

/** A choice of one option, each with the title people see. */
const titledSingleSelectSchema = Schema.Struct({
	type: Schema.Literal("string"),
	title,
	description,
	oneOf: titledOptions,
	default: Schema.optional(Schema.String),
});

const textSchema = Schema.Struct({
	type: Schema.Literal("string"),
	title,
	description,
	minLength: length,
	maxLength: length,
	pattern: Schema.optional(Schema.String.check(Schema.isMaxLength(500))),
	format: Schema.optional(formStringFormatSchema),
	default: Schema.optional(Schema.String),
});

const numberSchema = Schema.Struct({
	type: Schema.Literals(["number", "integer"]),
	title,
	description,
	minimum: Schema.optional(Schema.Finite),
	maximum: Schema.optional(Schema.Finite),
	default: Schema.optional(Schema.Finite),
});

const booleanSchema = Schema.Struct({
	type: Schema.Literal("boolean"),
	title,
	description,
	default: Schema.optional(Schema.Boolean),
});

/** A choice of any number of options, given as bare values. */
const multiSelectSchema = Schema.Struct({
	type: Schema.Literal("array"),
	title,
	description,
	minItems: count,
	maxItems: count,
	items: Schema.Struct({ type: Schema.Literal("string"), enum: untitledOptions }),
	default: Schema.optional(Schema.Array(Schema.String)),
});

/** A choice of any number of options, each with the title people see. */
const titledMultiSelectSchema = Schema.Struct({
	type: Schema.Literal("array"),
	title,
	description,
	minItems: count,
	maxItems: count,
	items: Schema.Struct({ anyOf: titledOptions }),
	default: Schema.optional(Schema.Array(Schema.String)),
});

/**
 * One field of a form. The choices come before plain text because a choice is
 * also a `"string"`: the first member a field decodes as is the one it is.
 */
export const formFieldSchema = Schema.Union([
	titledSingleSelectSchema,
	singleSelectSchema,
	textSchema,
	numberSchema,
	booleanSchema,
	titledMultiSelectSchema,
	multiSelectSchema,
]);

export type FormField = typeof formFieldSchema.Type;

export const formRequestSchema = Schema.Struct({
	message: Schema.String.check(
		Schema.isMinLength(1),
		Schema.isMaxLength(MAX_FORM_MESSAGE_CHARACTERS),
	).annotate({ description: "What you are asking and why, shown above the fields" }),
	requestedSchema: Schema.Struct({
		type: Schema.Literal("object"),
		properties: Schema.Record(Schema.String, formFieldSchema).annotate({
			description:
				"The fields, keyed by the name each answer comes back under, in the order people see them",
		}),
		required: Schema.optional(Schema.Array(Schema.String)),
	}),
});

export type FormRequest = typeof formRequestSchema.Type;

/** One answer to one field: text, a number, a yes or no, or the values of the options chosen. */
export const formFieldValueSchema = Schema.Union([
	Schema.String.check(Schema.isMaxLength(MAX_FORM_TEXT_ANSWER_CHARACTERS)),
	Schema.Finite,
	Schema.Boolean,
	Schema.Array(Schema.String).check(Schema.isMaxLength(MAX_FORM_OPTIONS)),
]);

export type FormFieldValue = typeof formFieldValueSchema.Type;

export const formContentSchema = Schema.Record(Schema.String, formFieldValueSchema);

export type FormContent = typeof formContentSchema.Type;

/**
 * What a person did with a form, as MCP's elicitation result has it:
 * `accept` with their answers, or `decline`. MCP's third action, `cancel`,
 * is never sent: a form nobody answered is cancelled when its turn ends.
 */
export const formAnswerSchema = Schema.Union([
	Schema.Struct({ action: Schema.Literal("accept"), content: formContentSchema }),
	Schema.Struct({ action: Schema.Literal("decline") }),
]);

export type FormAnswer = typeof formAnswerSchema.Type;

type TextField = typeof textSchema.Type;
type NumberField = typeof numberSchema.Type;
type BooleanField = typeof booleanSchema.Type;
type SingleSelectField = typeof singleSelectSchema.Type | typeof titledSingleSelectSchema.Type;
type MultiSelectField = typeof multiSelectSchema.Type | typeof titledMultiSelectSchema.Type;

/** A field together with the kind of control it is answered with. */
export type ClassifiedFormField =
	| { readonly kind: "text"; readonly field: TextField }
	| { readonly kind: "number"; readonly field: NumberField }
	| { readonly kind: "boolean"; readonly field: BooleanField }
	| { readonly kind: "single-select"; readonly field: SingleSelectField }
	| { readonly kind: "multi-select"; readonly field: MultiSelectField };

export type FormFieldKind = ClassifiedFormField["kind"];

export interface FormOption {
	value: string;
	label: string;
}

/** What control a field is answered with. */
export function classifyFormField(field: FormField): ClassifiedFormField {
	switch (field.type) {
		case "boolean":
			return { kind: "boolean", field };
		case "number":
		case "integer":
			return { kind: "number", field };
		case "array":
			return { kind: "multi-select", field };
		case "string":
			return "enum" in field || "oneOf" in field
				? { kind: "single-select", field }
				: { kind: "text", field };
	}
}

/** The options of a choice, with what people see for each; none for any other field. */
export function formFieldOptions(field: FormField): readonly FormOption[] {
	if ("oneOf" in field)
		return field.oneOf.map(({ const: value, title }) => ({ value, label: title }));
	if ("enum" in field) return field.enum.map((value) => ({ value, label: value }));
	if (field.type !== "array") return [];
	if ("anyOf" in field.items) {
		return field.items.anyOf.map(({ const: value, title }) => ({ value, label: title }));
	}
	return field.items.enum.map((value) => ({ value, label: value }));
}

/** The fields in the order the agent wrote them, which is the order people see them in. */
export function formFields(request: FormRequest): ReadonlyArray<readonly [string, FormField]> {
	return Object.entries(request.requestedSchema.properties);
}

/** The fields named in `order`, in that order: a form's fields as the agent wrote them. */
export function formFieldsInOrder(
	request: FormRequest,
	order: readonly string[],
): ReadonlyArray<readonly [string, FormField]> {
	return order.flatMap((name) => {
		const field = request.requestedSchema.properties[name];
		return field ? [[name, field] as const] : [];
	});
}

export function isRequiredField(request: FormRequest, name: string): boolean {
	return request.requestedSchema.required?.includes(name) ?? false;
}

/**
 * What is wrong with a form an agent asked for, beyond its shape: names that
 * are not field names, a `required` naming no field, defaults the field
 * would refuse, bounds that cross, and patterns that do not compile. Empty
 * when it can be shown.
 */
export function formRequestProblems(request: FormRequest): string[] {
	const fields = formFields(request);
	const problems: string[] = [];
	if (fields.length === 0) problems.push("The form has no fields.");
	if (fields.length > MAX_FORM_FIELDS) {
		problems.push(`The form has more than ${MAX_FORM_FIELDS} fields.`);
	}
	for (const name of request.requestedSchema.required ?? []) {
		if (!Object.hasOwn(request.requestedSchema.properties, name)) {
			problems.push(`"${name}" is required but is not a field.`);
		}
	}
	for (const [name, field] of fields) {
		if (!FIELD_NAME_PATTERN.test(name)) {
			problems.push(
				`"${name}" is not a usable field name: use 1 to 64 letters, digits, "_" or "-".`,
			);
		}
		// Assigning `__proto__` on a plain object sets its prototype, so its answer would be lost.
		if (name === "__proto__") problems.push(`"${name}" is not a usable field name.`);
		problems.push(...boundsProblems(name, classifyFormField(field)));
		if (field.default !== undefined) {
			const problem = valueProblem(field, field.default);
			if (problem) problems.push(`"${name}" has a default that does not fit it: ${problem}`);
		}
	}
	return problems;
}

function boundsProblems(name: string, classified: ClassifiedFormField): string[] {
	switch (classified.kind) {
		case "text": {
			const { field } = classified;
			const problems: string[] = [];
			if (crosses(field.minLength, field.maxLength)) {
				problems.push(`"${name}" has a minLength above its maxLength.`);
			}
			if (Math.max(field.minLength ?? 0, field.maxLength ?? 0) > MAX_FORM_TEXT_ANSWER_CHARACTERS) {
				problems.push(
					`"${name}" asks for more than ${MAX_FORM_TEXT_ANSWER_CHARACTERS} characters, the most an answer may have.`,
				);
			}
			if (field.pattern !== undefined && compiled(field.pattern) === undefined) {
				problems.push(`"${name}" has a pattern that is not a valid regular expression.`);
			}
			return problems;
		}
		case "number":
			return crosses(classified.field.minimum, classified.field.maximum)
				? [`"${name}" has a minimum above its maximum.`]
				: [];
		case "multi-select": {
			const problems = repeatedOptionProblems(name, classified.field);
			if (crosses(classified.field.minItems, classified.field.maxItems)) {
				problems.push(`"${name}" has minItems above its maxItems.`);
			}
			return problems;
		}
		case "single-select":
			return repeatedOptionProblems(name, classified.field);
		case "boolean":
			return [];
	}
}

function repeatedOptionProblems(name: string, field: FormField): string[] {
	const values = formFieldOptions(field).map((option) => option.value);
	return new Set(values).size === values.length
		? []
		: [`"${name}" offers the same option value twice.`];
}

function crosses(low: number | undefined, high: number | undefined): boolean {
	return low !== undefined && high !== undefined && low > high;
}

function compiled(pattern: string): RegExp | undefined {
	try {
		return new RegExp(pattern);
	} catch {
		return undefined;
	}
}

/**
 * What is wrong with answers to `request`, by field name: fields the form
 * does not have, required fields left out, and values their field refuses.
 * Empty when the answers can be sent. A field left unanswered is left out of
 * the content, not sent empty.
 */
export function formContentProblems(
	request: FormRequest,
	content: FormContent,
): Record<string, string> {
	const problems: Record<string, string> = {};
	const { properties } = request.requestedSchema;
	for (const name of Object.keys(content)) {
		if (!Object.hasOwn(properties, name)) problems[name] = "The form has no such field.";
	}
	for (const [name, field] of formFields(request)) {
		const value = content[name];
		if (value === undefined) {
			if (isRequiredField(request, name)) problems[name] = "This field is required.";
			continue;
		}
		const problem = valueProblem(field, value);
		if (problem) problems[name] = problem;
	}
	return problems;
}

function valueProblem(field: FormField, value: FormFieldValue): string | undefined {
	const classified = classifyFormField(field);
	switch (classified.kind) {
		case "boolean":
			return typeof value === "boolean" ? undefined : "Expected yes or no.";
		case "number":
			return typeof value === "number"
				? numberProblem(classified.field, value)
				: "Expected a number.";
		case "single-select":
			if (typeof value !== "string") return "Expected one option.";
			return formFieldOptions(field).some((option) => option.value === value)
				? undefined
				: "Expected one of the options.";
		case "multi-select":
			return Array.isArray(value)
				? choicesProblem(classified.field, value)
				: "Expected a list of options.";
		case "text":
			return typeof value === "string" ? textProblem(classified.field, value) : "Expected text.";
	}
}

function numberProblem(field: NumberField, value: number): string | undefined {
	if (field.type === "integer" && !Number.isInteger(value)) return "Expected a whole number.";
	if (field.minimum !== undefined && value < field.minimum) {
		return `Must be at least ${field.minimum}.`;
	}
	if (field.maximum !== undefined && value > field.maximum) {
		return `Must be at most ${field.maximum}.`;
	}
	return undefined;
}

function choicesProblem(field: MultiSelectField, values: readonly string[]): string | undefined {
	const offered = new Set(formFieldOptions(field).map((option) => option.value));
	if (values.some((value) => !offered.has(value))) return "Expected only the options offered.";
	if (new Set(values).size !== values.length) return "Each option may be chosen once.";
	if (field.minItems !== undefined && values.length < field.minItems) {
		return `Choose at least ${field.minItems}.`;
	}
	if (field.maxItems !== undefined && values.length > field.maxItems) {
		return `Choose at most ${field.maxItems}.`;
	}
	return undefined;
}

function textProblem(field: TextField, value: string): string | undefined {
	const characters = [...value].length;
	const maxLength = field.maxLength ?? MAX_FORM_TEXT_ANSWER_CHARACTERS;
	if (field.minLength !== undefined && characters < field.minLength) {
		return `Must be at least ${field.minLength} characters.`;
	}
	if (characters > maxLength) return `Must be at most ${maxLength} characters.`;
	if (field.format !== undefined && !FORMAT_CHECKS[field.format](value)) {
		return FORMAT_PROBLEMS[field.format];
	}
	const pattern = field.pattern === undefined ? undefined : compiled(field.pattern);
	if (pattern && !pattern.test(value)) return "Does not match the expected format.";
	return undefined;
}

const DATE = /^\d{4}-\d{2}-\d{2}$/;
const DATE_TIME = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(:\d{2}(\.\d+)?)?(Z|[+-]\d{2}:\d{2})$/;

const FORMAT_CHECKS: Record<FormStringFormat, (value: string) => boolean> = {
	email: (value) => /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value),
	uri: (value) => URL.canParse(value),
	date: (value) => DATE.test(value) && !Number.isNaN(Date.parse(value)),
	"date-time": (value) => DATE_TIME.test(value) && !Number.isNaN(Date.parse(value)),
};

const FORMAT_PROBLEMS: Record<FormStringFormat, string> = {
	email: "Expected an email address.",
	uri: "Expected a full web address, such as https://example.com.",
	date: "Expected a date.",
	"date-time": "Expected a date and time.",
};
