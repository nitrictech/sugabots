import { Result, Schema } from "effect";
import { describe, expect, it } from "vitest";
import { newPodSchema, podUpdateSchema, slugify } from "./pods.ts";

describe("pod request contracts", () => {
	it("trims names and rejects blank or oversized values", () => {
		expect(Schema.decodeUnknownSync(newPodSchema)({ name: "  Sales  " }).name).toBe("Sales");
		expect(Result.isSuccess(Schema.decodeUnknownResult(newPodSchema)({ name: "   " }))).toBe(false);
		expect(
			Result.isSuccess(Schema.decodeUnknownResult(newPodSchema)({ name: "x".repeat(65) })),
		).toBe(false);
		expect(
			Schema.decodeUnknownSync(newPodSchema)({ name: ` ${"x".repeat(64)} ` }).name,
		).toHaveLength(64);
	});

	it("validates routing updates", () => {
		for (const input of [
			{ routing: {} },
			{ routing: { facilitator: "yes" } },
			{ routing: null },
			{ name: " " },
			{ slug: " Sales " },
		]) {
			expect(Result.isFailure(Schema.decodeUnknownResult(podUpdateSchema)(input))).toBe(true);
		}
	});

	it("derives bounded slugs without trailing separators", () => {
		expect(slugify("  Suga Team!  ")).toBe("suga-team");
		expect(slugify(`${"a".repeat(47)} -- suffix`)).toBe("a".repeat(47));
	});
});
