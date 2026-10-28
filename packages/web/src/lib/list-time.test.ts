import { describe, expect, it } from "vitest";
import { formatAge, formatListTime } from "./list-time.ts";

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
