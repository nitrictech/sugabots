import { Schema } from "effect";
import { describe, expect, it } from "vitest";
import {
	type FormContent,
	formContentProblems,
	formRequestProblems,
	formRequestSchema,
} from "./forms.ts";

const decodeForm = Schema.decodeUnknownSync(formRequestSchema);

/** A form with one field of each kind MCP's form mode allows. */
const form = decodeForm({
	message: "Plan the launch",
	requestedSchema: {
		type: "object",
		properties: {
			post: { type: "string", maxLength: 5, default: "Hi" },
			launch: { type: "string", format: "date-time" },
			contact: { type: "string", format: "email" },
			budget: { type: "integer", minimum: 0, maximum: 10 },
			announce: { type: "boolean", default: true },
			channel: { type: "string", oneOf: [{ const: "x", title: "X" }] },
			regions: { type: "array", items: { type: "string", enum: ["eu", "us"] }, maxItems: 1 },
		},
		required: ["post"],
	},
});

describe("formRequestSchema", () => {
	it("keeps the fields in the order the agent wrote them", () => {
		expect(Object.keys(form.requestedSchema.properties)).toEqual([
			"post",
			"launch",
			"contact",
			"budget",
			"announce",
			"channel",
			"regions",
		]);
	});

	it("refuses a field nested past MCP's flat primitives", () => {
		expect(() =>
			decodeForm({
				message: "Nested",
				requestedSchema: { type: "object", properties: { address: { type: "object" } } },
			}),
		).toThrow();
	});
});

describe("formRequestProblems", () => {
	it("finds nothing wrong with a form that can be shown", () => {
		expect(formRequestProblems(form)).toEqual([]);
	});

	it.each([
		[{ required: ["missing"] }, '"missing" is required but is not a field.'],
		[
			{ properties: { size: { type: "string", enum: ["s", "m"], default: "xl" } } },
			'"size" has a default that does not fit it',
		],
		[
			{ properties: { count: { type: "number", minimum: 5, maximum: 1 } } },
			'"count" has a minimum above its maximum.',
		],
		[
			{ properties: { code: { type: "string", pattern: "(" } } },
			'"code" has a pattern that is not a valid regular expression.',
		],
		[
			{ properties: { code: { type: "string", maxLength: 20_000 } } },
			'"code" asks for more than 10000 characters',
		],
		[
			{ properties: { "two words": { type: "boolean" } } },
			'"two words" is not a usable field name',
		],
		[
			JSON.parse('{"properties": {"__proto__": {"type": "boolean"}}}'),
			'"__proto__" is not a usable field name.',
		],
		[{ required: ["toString"] }, '"toString" is required but is not a field.'],
		[{ properties: {} }, "The form has no fields."],
	])("says what is wrong with %j", (change, problem) => {
		const broken = decodeForm({
			message: "Broken",
			requestedSchema: { type: "object", properties: { ok: { type: "boolean" } }, ...change },
		});

		expect(formRequestProblems(broken).join(" ")).toContain(problem);
	});

	it("takes a pattern written for JSON Schema rather than for unicode regular expressions", () => {
		const phone = decodeForm({
			message: "Phone",
			requestedSchema: {
				type: "object",
				properties: { phone: { type: "string", pattern: "^\\d{3}\\-\\d{4}$" } },
			},
		});

		expect(formRequestProblems(phone)).toEqual([]);
		expect(formContentProblems(phone, { phone: "555-1234" })).toEqual({});
	});
});

describe("formContentProblems", () => {
	it("takes answers that fit, leaving optional fields out", () => {
		const content: FormContent = {
			post: "Hi 👋",
			launch: "2026-11-02T09:30:00+11:00",
			budget: 3,
			regions: ["eu"],
		};

		expect(formContentProblems(form, content)).toEqual({});
	});

	it.each<[FormContent, Record<string, string>]>([
		[{}, { post: "This field is required." }],
		[{ post: "Hi", other: "x" }, { other: "The form has no such field." }],
		[{ post: "Hi", toString: "x" }, { toString: "The form has no such field." }],
		[{ post: "Hello!" }, { post: "Must be at most 5 characters." }],
		[{ post: "Hi", launch: "next Tuesday" }, { launch: "Expected a date and time." }],
		[{ post: "Hi", contact: "sam" }, { contact: "Expected an email address." }],
		[{ post: "Hi", budget: 2.5 }, { budget: "Expected a whole number." }],
		[{ post: "Hi", budget: 11 }, { budget: "Must be at most 10." }],
		[{ post: "Hi", channel: "y" }, { channel: "Expected one of the options." }],
		[{ post: "Hi", regions: ["eu", "us"] }, { regions: "Choose at most 1." }],
		[{ post: "Hi", announce: "yes" }, { announce: "Expected yes or no." }],
	])("refuses %j", (content, problems) => {
		expect(formContentProblems(form, content)).toEqual(problems);
	});
});
