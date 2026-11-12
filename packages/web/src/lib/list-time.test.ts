import { describe, expect, it } from "vitest";
import {
	formatAge,
	formatListTime,
	formatListTimeInSentence,
	formatTimeAfterVerb,
} from "./list-time.ts";

const now = new Date(2026, 8, 25, 18, 30);

describe("a conversation list's times", () => {
	it("shows the time for today, without a day period", () => {
		expect(formatListTime(new Date(2026, 8, 25, 6, 12), now, "en-AU")).toBe("6:12");
	});

	it("says Yesterday for yesterday, even minutes past midnight", () => {
		expect(formatListTime(new Date(2026, 8, 24, 23, 59), now, "en-AU")).toBe("Yesterday");
	});

	it("names the weekday within the week, then the date", () => {
		expect(formatListTime(new Date(2026, 8, 22, 9, 0), now, "en-AU")).toBe("Tue");
		expect(formatListTime(new Date(2026, 8, 12, 9, 0), now, "en-AU")).toBe("12 Sept");
	});

	it("adds the year only for another year", () => {
		expect(formatListTime(new Date(2025, 11, 3, 9, 0), now, "en-AU")).toBe("3 Dec 2025");
	});

	it("lowers yesterday inside a sentence, but keeps weekday and month names' capitals", () => {
		const inSentence = (at: Date) => formatListTimeInSentence(at, now, "en-AU");
		expect(inSentence(new Date(2026, 8, 24, 9, 0))).toBe("yesterday");
		expect(inSentence(new Date(2026, 8, 22, 9, 0))).toBe("Tue");
		expect(inSentence(new Date(2026, 8, 12, 9, 0))).toBe("12 Sept");
	});
});

describe("a time after a verb", () => {
	const afterVerb = (at: Date) => formatTimeAfterVerb(at, now, "en-AU");

	it("says the time for today, the weekday within the week, then the date", () => {
		expect(afterVerb(new Date(2026, 8, 25, 6, 12))).toBe("at 6:12");
		expect(afterVerb(new Date(2026, 8, 24, 23, 59))).toBe("yesterday");
		expect(afterVerb(new Date(2026, 8, 22, 9, 0))).toBe("on Tuesday");
		expect(afterVerb(new Date(2026, 8, 12, 9, 0))).toBe("on 12 Sept");
	});

	it("adds the year only for another year", () => {
		expect(afterVerb(new Date(2025, 11, 3, 9, 0))).toBe("on 3 Dec 2025");
	});
});

describe("a list's ages", () => {
	it("shows the time for today", () => {
		expect(formatAge(new Date(2026, 8, 25, 6, 12), now, "en-AU")).toBe("6:12");
	});

	it("counts days until a month has passed", () => {
		expect(formatAge(new Date(2026, 8, 24, 23, 59), now, "en-AU")).toBe("1d");
		expect(formatAge(new Date(2026, 8, 20, 9, 0), now, "en-AU")).toBe("5d");
		expect(formatAge(new Date(2026, 7, 26, 9, 0), now, "en-AU")).toBe("30d");
	});

	it("counts whole months, then whole years", () => {
		expect(formatAge(new Date(2026, 7, 25, 9, 0), now, "en-AU")).toBe("1m");
		expect(formatAge(new Date(2025, 9, 1, 9, 0), now, "en-AU")).toBe("11m");
		expect(formatAge(new Date(2025, 8, 25, 9, 0), now, "en-AU")).toBe("1y");
		expect(formatAge(new Date(2023, 0, 1, 9, 0), now, "en-AU")).toBe("3y");
	});
});
