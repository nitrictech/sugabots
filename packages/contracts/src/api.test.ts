import { Result, Schema } from "effect";
import { describe, expect, it } from "vitest";
import {
	healthResponseSchema,
	isoTimestampSchema,
	sessionUserSchema,
	trialAccuracySchema,
	trialCaseResultSchema,
	trialSpeedSchema,
} from "./index.ts";

describe("healthResponseSchema", () => {
	it("accepts a healthy response", () => {
		expect(
			Schema.decodeUnknownSync(healthResponseSchema)({
				status: "ok",
				version: "0.0.0",
				extra: true,
			}),
		).toEqual({
			status: "ok",
			version: "0.0.0",
		});
	});

	it("rejects an unknown status", () => {
		expect(
			Result.isSuccess(
				Schema.decodeUnknownResult(healthResponseSchema)({ status: "down", version: "0.0.0" }),
			),
		).toBe(false);
	});
});

describe("sessionUserSchema", () => {
	const sam = {
		id: "0199a3a0-0000-7000-8000-000000000009",
		email: "sam@example.com",
		name: "Sam",
		image: null,
	};

	it("accepts a user with no avatar", () => {
		expect(Schema.decodeSync(sessionUserSchema)(sam)).toEqual(sam);
	});

	it("rejects a user without a usable id", () => {
		expect(Result.isSuccess(Schema.decodeResult(sessionUserSchema)({ ...sam, id: "1" }))).toBe(
			false,
		);
	});

	it.each(["sam+tag@example.com", "sam@sub.example.com"])("accepts email %s", (email) => {
		expect(Result.isSuccess(Schema.decodeResult(sessionUserSchema)({ ...sam, email }))).toBe(true);
	});

	it.each([
		"sam@localhost",
		"a@b-.com",
		".sam@example.com",
		"sam..smith@example.com",
		"sam@example.c",
		" sam@example.com",
	])("rejects email %s", (email) => {
		expect(Result.isFailure(Schema.decodeResult(sessionUserSchema)({ ...sam, email }))).toBe(true);
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

describe("model trial numbers", () => {
	const speed = { typicalMs: 0, slowestMs: 1.5, budgetMs: 2, rating: "good" };
	const accuracy = { passed: 0, attempts: 1, share: 0, needed: 1, rating: "good" };
	it("accepts finite boundaries and optional examples, stripping unknown fields", () => {
		expect(Schema.decodeUnknownSync(trialSpeedSchema)({ ...speed, extra: true })).toEqual(speed);
		expect(Schema.decodeUnknownSync(trialAccuracySchema)(accuracy)).toEqual(accuracy);
		expect(
			Schema.decodeSync(trialCaseResultSchema)({
				name: "case",
				passed: 0,
				attempts: Number.MAX_SAFE_INTEGER,
				example: undefined,
			}),
		).toEqual({ name: "case", passed: 0, attempts: Number.MAX_SAFE_INTEGER, example: undefined });
	});
	it.each([NaN, Infinity, -Infinity, -1, "1"])("rejects invalid duration %s", (value) => {
		for (const field of ["typicalMs", "slowestMs", "budgetMs"]) {
			expect(
				Result.isFailure(
					Schema.decodeUnknownResult(trialSpeedSchema)({ ...speed, [field]: value }),
				),
			).toBe(true);
		}
	});
	it("rejects zero budgets, unsafe or fractional counts, and out-of-range shares", () => {
		expect(
			Result.isFailure(Schema.decodeUnknownResult(trialSpeedSchema)({ ...speed, budgetMs: 0 })),
		).toBe(true);
		for (const fields of [
			{ passed: Number.MAX_SAFE_INTEGER + 1 },
			{ passed: 0.5 },
			{ attempts: 0 },
			{ share: 1.01 },
			{ needed: -0.01 },
			{ share: NaN },
			{ needed: Infinity },
		]) {
			expect(
				Result.isFailure(
					Schema.decodeUnknownResult(trialAccuracySchema)({ ...accuracy, ...fields }),
				),
			).toBe(true);
		}
	});
});
