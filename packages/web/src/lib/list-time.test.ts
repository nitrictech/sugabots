import { describe, expect, it } from "vitest";
import { formatListTime } from "./list-time.ts";

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
