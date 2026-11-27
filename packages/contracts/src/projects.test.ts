import { Result, Schema } from "effect";
import { describe, expect, it } from "vitest";
import {
	newProjectSchema,
	PROJECT_NAME_MAX_LENGTH,
	projectUpdateSchema,
	slugify,
} from "./projects.ts";

const leadBotId = "0199a3a0-0000-7000-8000-0000000000b1";

describe("project request contracts", () => {
	it("trims names and rejects blank or oversized values", () => {
		const named = (name: string) => ({ name, leadBotId });
		expect(Schema.decodeSync(newProjectSchema)(named("  Sales  ")).name).toBe("Sales");
		expect(Result.isSuccess(Schema.decodeResult(newProjectSchema)(named("   ")))).toBe(false);
		expect(
			Result.isSuccess(
				Schema.decodeResult(newProjectSchema)(named("x".repeat(PROJECT_NAME_MAX_LENGTH + 1))),
			),
		).toBe(false);
		expect(
			Schema.decodeSync(newProjectSchema)(named(` ${"x".repeat(PROJECT_NAME_MAX_LENGTH)} `)).name,
		).toHaveLength(PROJECT_NAME_MAX_LENGTH);
	});

	it("needs a lead bot for a new project", () => {
		expect(Result.isFailure(Schema.decodeUnknownResult(newProjectSchema)({ name: "Sales" }))).toBe(
			true,
		);
	});

	it("validates project updates", () => {
		for (const input of [{ name: " " }, { slug: " Sales " }]) {
			expect(Result.isFailure(Schema.decodeUnknownResult(projectUpdateSchema)(input))).toBe(true);
		}
	});

	it("derives bounded slugs without trailing separators", () => {
		expect(slugify("  Suga Team!  ")).toBe("suga-team");
		expect(slugify(`${"a".repeat(47)} -- suffix`)).toBe("a".repeat(47));
	});
});
