import { Effect } from "effect";
import { describe, expect, it } from "vitest";
import {
	InvalidRoutineSchedule,
	latestMissedAndNextOccurrence,
	upcomingOccurrences,
} from "./schedule.ts";

describe("Routine schedules", () => {
	it("calculates minute-precision occurrences in the selected timezone", async () => {
		const dates = await Effect.runPromise(
			upcomingOccurrences("0 9 * * 1-5", "Australia/Sydney", 2, new Date("2026-09-18T00:00:00Z")),
		);
		expect(dates.map((date) => date.toISOString())).toEqual([
			"2026-09-20T23:00:00.000Z",
			"2026-09-21T23:00:00.000Z",
		]);
	});

	it("rejects six-field expressions and unknown timezones", async () => {
		await expect(Effect.runPromise(upcomingOccurrences("0 0 9 * * 1-5", "UTC"))).rejects.toThrow(
			InvalidRoutineSchedule,
		);
		await expect(
			Effect.runPromise(upcomingOccurrences("0 9 * * *", "Not/A_Timezone")),
		).rejects.toThrow(InvalidRoutineSchedule);
	});

	it("selects only the latest missed occurrence after downtime", async () => {
		const occurrence = await Effect.runPromise(
			latestMissedAndNextOccurrence("*/15 * * * *", "UTC", new Date("2026-09-18T12:37:40Z")),
		);
		expect(occurrence.latest.toISOString()).toBe("2026-09-18T12:30:00.000Z");
		expect(occurrence.next.toISOString()).toBe("2026-09-18T12:45:00.000Z");
	});
});
