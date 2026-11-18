import { Result, Schema } from "effect";
import { describe, expect, it } from "vitest";
import { channelUpdateSchema, newChannelSchema, slugify } from "./channels.ts";

describe("channel request contracts", () => {
	it("trims names and rejects blank or oversized values", () => {
		expect(Schema.decodeSync(newChannelSchema)({ name: "  Sales  " }).name).toBe("Sales");
		expect(Result.isSuccess(Schema.decodeResult(newChannelSchema)({ name: "   " }))).toBe(false);
		expect(Result.isSuccess(Schema.decodeResult(newChannelSchema)({ name: "x".repeat(65) }))).toBe(
			false,
		);
		expect(Schema.decodeSync(newChannelSchema)({ name: ` ${"x".repeat(64)} ` }).name).toHaveLength(
			64,
		);
	});

	it("validates channel updates", () => {
		for (const input of [{ name: " " }, { slug: " Sales " }]) {
			expect(Result.isFailure(Schema.decodeUnknownResult(channelUpdateSchema)(input))).toBe(true);
		}
	});

	it("derives bounded slugs without trailing separators", () => {
		expect(slugify("  Suga Team!  ")).toBe("suga-team");
		expect(slugify(`${"a".repeat(47)} -- suffix`)).toBe("a".repeat(47));
	});
});
