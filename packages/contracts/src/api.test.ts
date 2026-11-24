import { Result, Schema } from "effect";
import { describe, expect, it } from "vitest";
import { currentUserSchema, healthResponseSchema, isoTimestampSchema } from "./index.ts";

describe("healthResponseSchema", () => {
	it("accepts a healthy response", () => {
		expect(
			Schema.decodeUnknownSync(healthResponseSchema)({
				status: "ok",
				version: "0.2.0",
				commit: "a1b2c3d",
				extra: true,
			}),
		).toEqual({
			status: "ok",
			version: "0.2.0",
			commit: "a1b2c3d",
		});
	});

	it("rejects an unknown status", () => {
		expect(
			Result.isSuccess(
				Schema.decodeUnknownResult(healthResponseSchema)({
					status: "down",
					version: "0.2.0",
					commit: null,
				}),
			),
		).toBe(false);
	});
});

describe("currentUserSchema", () => {
	const sam = {
		id: "0199a3a0-0000-7000-8000-000000000009",
		email: "sam@example.com",
		name: "Sam",
		image: null,
	};

	it("accepts a user with no avatar", () => {
		expect(Schema.decodeSync(currentUserSchema)(sam)).toEqual(sam);
	});

	it("rejects a user without a usable id", () => {
		expect(Result.isSuccess(Schema.decodeResult(currentUserSchema)({ ...sam, id: "1" }))).toBe(
			false,
		);
	});

	it.each(["sam+tag@example.com", "sam@sub.example.com"])("accepts email %s", (email) => {
		expect(Result.isSuccess(Schema.decodeResult(currentUserSchema)({ ...sam, email }))).toBe(true);
	});

	it.each([
		"sam@localhost",
		"a@b-.com",
		".sam@example.com",
		"sam..smith@example.com",
		"sam@example.c",
		" sam@example.com",
	])("rejects email %s", (email) => {
		expect(Result.isFailure(Schema.decodeResult(currentUserSchema)({ ...sam, email }))).toBe(true);
	});
});

describe("timestamp format", () => {
	it.each([
		"2024-02-29T23:59:00Z",
		"2000-02-29T00:00:00Z",
		"2026-09-15T00:00:00.123456789Z",
		"2026-09-15T12:00:00+05:30",
		"2026-09-15T12:00:00-04:00",
	])("preserves timestamp string %s", (timestamp) => {
		expect(Schema.decodeSync(isoTimestampSchema)(timestamp)).toBe(timestamp);
	});
	it.each([
		"2026-09-15T12:00Z",
		"2024-02-29T23:59Z",
		"1900-02-29T00:00:00Z",
		"2026-02-29T00:00:00Z",
		"2026-04-31T00:00:00Z",
		"2026-01-01T24:00:00Z",
		"2026-01-01T00:00:60Z",
		"2026-01-01",
		"2026-01-01T",
		"2026-01-01TZ",
		"2026-01-01T00:00:00+25:00",
		"2026-01-01T00:00:00",
		"2026-01-01t00:00:00z",
	])("rejects timestamp %s", (timestamp) => {
		expect(Result.isFailure(Schema.decodeResult(isoTimestampSchema)(timestamp))).toBe(true);
	});
});
