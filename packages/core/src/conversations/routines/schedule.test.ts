import type { CalendarSchedule } from "@sugabots/contracts";
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
			upcomingOccurrences(
				{ repeat: "cron", expression: "0 9 * * 1-5" },
				"Australia/Sydney",
				new Date("2026-09-18T00:00:00Z"),
				2,
			),
		);
		expect(dates.map((date) => date.toISOString())).toEqual([
			"2026-09-20T23:00:00.000Z",
			"2026-09-21T23:00:00.000Z",
		]);
	});

	it("rejects six-field expressions and unknown timezones", async () => {
		await expect(
			Effect.runPromise(
				upcomingOccurrences({ repeat: "cron", expression: "0 0 9 * * 1-5" }, "UTC", new Date()),
			),
		).rejects.toThrow(InvalidRoutineSchedule);
		await expect(
			Effect.runPromise(
				upcomingOccurrences(
					{ repeat: "cron", expression: "0 9 * * *" },
					"Not/A_Timezone",
					new Date(),
				),
			),
		).rejects.toThrow(InvalidRoutineSchedule);
	});

	it("selects only the latest missed occurrence after downtime", async () => {
		const occurrence = await Effect.runPromise(
			latestMissedAndNextOccurrence(
				{ repeat: "cron", expression: "*/15 * * * *" },
				"UTC",
				new Date("2026-09-18T12:37:40Z"),
			),
		);
		expect(occurrence.latest.toISOString()).toBe("2026-09-18T12:30:00.000Z");
		expect(occurrence.next.toISOString()).toBe("2026-09-18T12:45:00.000Z");
	});
});

describe("Routine schedules picked by their parts", () => {
	const upcoming = (schedule: CalendarSchedule, timezone: string, from: string, count = 3) =>
		Effect.runPromise(upcomingOccurrences(schedule, timezone, new Date(from), count)).then(
			(dates) => dates.map((date) => date.toISOString()),
		);
	const at = (hours: number, minutes = 0) => hours * 60 + minutes;

	it("runs at each of several times a day, in the routine's time zone", async () => {
		const twiceDaily: CalendarSchedule = {
			repeat: "daily",
			every: 1,
			times: [at(13, 30), at(9)],
			startsOn: "2026-10-01",
		};
		// 11:00 in Sydney, where it is daylight saving time (UTC+11).
		expect(await upcoming(twiceDaily, "Australia/Sydney", "2026-10-08T00:00:00Z")).toEqual([
			"2026-10-08T02:30:00.000Z",
			"2026-10-08T22:00:00.000Z",
			"2026-10-09T02:30:00.000Z",
		]);
	});

	it("runs every second Friday, counting from the week it starts", async () => {
		const fortnightly: CalendarSchedule = {
			repeat: "weekly",
			every: 2,
			days: ["fri"],
			times: [at(10)],
			startsOn: "2026-10-05",
		};
		expect(await upcoming(fortnightly, "UTC", "2026-10-05T00:00:00Z")).toEqual([
			"2026-10-09T10:00:00.000Z",
			"2026-10-23T10:00:00.000Z",
			"2026-11-06T10:00:00.000Z",
		]);
	});

	it("runs on the last day of each month, however long the month", async () => {
		const monthEnd: CalendarSchedule = {
			repeat: "monthly",
			every: 1,
			dayOfMonth: "last",
			times: [at(9)],
			startsOn: "2026-01-01",
		};
		expect(await upcoming(monthEnd, "UTC", "2026-01-15T00:00:00Z")).toEqual([
			"2026-01-31T09:00:00.000Z",
			"2026-02-28T09:00:00.000Z",
			"2026-03-31T09:00:00.000Z",
		]);
	});

	it("keeps counting months across the turn of the year", async () => {
		const everyFiveMonths: CalendarSchedule = {
			repeat: "monthly",
			every: 5,
			dayOfMonth: 15,
			times: [at(9)],
			startsOn: "2026-01-01",
		};
		expect(await upcoming(everyFiveMonths, "UTC", "2026-01-01T00:00:00Z", 4)).toEqual([
			"2026-01-15T09:00:00.000Z",
			"2026-06-15T09:00:00.000Z",
			"2026-11-15T09:00:00.000Z",
			"2027-04-15T09:00:00.000Z",
		]);
	});

	it("keeps counting days across the end of a month", async () => {
		const everyThreeDays: CalendarSchedule = {
			repeat: "daily",
			every: 3,
			times: [at(0)],
			startsOn: "2026-01-30",
		};
		expect(await upcoming(everyThreeDays, "UTC", "2026-01-29T00:00:00Z")).toEqual([
			"2026-01-30T00:00:00.000Z",
			"2026-02-02T00:00:00.000Z",
			"2026-02-05T00:00:00.000Z",
		]);
	});

	it("runs a time the clocks skip at the next time that exists", async () => {
		const early: CalendarSchedule = {
			repeat: "daily",
			every: 1,
			times: [at(2, 30)],
			startsOn: "2026-10-01",
		};
		// Sydney's clocks go from 2:00 to 3:00 on 4 October 2026.
		const [onTheChange] = await upcoming(early, "Australia/Sydney", "2026-10-03T12:00:00Z", 1);
		expect(onTheChange).toBe("2026-10-03T16:30:00.000Z");
	});

	it("selects only the latest missed run after downtime", async () => {
		const daily: CalendarSchedule = {
			repeat: "daily",
			every: 1,
			times: [at(9)],
			startsOn: "2026-01-01",
		};
		const occurrence = await Effect.runPromise(
			latestMissedAndNextOccurrence(daily, "UTC", new Date("2026-01-03T12:00:00Z")),
		);
		expect(occurrence.latest.toISOString()).toBe("2026-01-03T09:00:00.000Z");
		expect(occurrence.next.toISOString()).toBe("2026-01-04T09:00:00.000Z");
	});
});
