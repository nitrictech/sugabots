import type { CalendarSchedule, Weekday } from "@sugabots/contracts";
import { DateTime } from "effect";

/*
 * When a calendar schedule runs. Days are counted as calendar dates in the
 * schedule's time zone, held as midnight UTC on that date so they step by a
 * day without the zone's clock changes getting in the way; only a run's own
 * moment is placed in the zone. A time a clock change skips runs at the next
 * time that exists, and a time it repeats runs at the first.
 */

const DAY_MS = 24 * 60 * 60 * 1000;
const DAYS_PER_WEEK = 7;
const MONTHS_PER_YEAR = 12;

/** Weekdays in `getUTCDay` order, Sunday first. */
const WEEKDAYS: readonly Weekday[] = ["sun", "mon", "tue", "wed", "thu", "fri", "sat"];

/**
 * How many days apart two runs can be at most, with room over: every twelfth
 * month on its last day.
 */
const LONGEST_GAP_DAYS = 400;

/** The schedule's next `count` runs after `after`, in order. */
export function calendarOccurrencesAfter(
	schedule: CalendarSchedule,
	timeZone: string,
	after: Date,
	count: number,
): Date[] {
	const times = [...schedule.times].sort((a, b) => a - b);
	const occurrences: Date[] = [];
	let day = localDay(after, timeZone);
	for (let searched = 0; searched < LONGEST_GAP_DAYS * count; searched++, day += DAY_MS) {
		if (!runsOn(schedule, day)) continue;
		for (const minutes of times) {
			const occurrence = instantAt(day, minutes, timeZone);
			if (occurrence <= after) continue;
			occurrences.push(occurrence);
			if (occurrences.length === count) return occurrences;
		}
	}
	return occurrences;
}

/** The schedule's latest run at or before `at`, if it has had one lately. */
export function calendarLatestAtOrBefore(
	schedule: CalendarSchedule,
	timeZone: string,
	at: Date,
): Date | undefined {
	const latestFirst = [...schedule.times].sort((a, b) => b - a);
	let day = localDay(at, timeZone);
	for (let searched = 0; searched < LONGEST_GAP_DAYS; searched++, day -= DAY_MS) {
		if (!runsOn(schedule, day)) continue;
		for (const minutes of latestFirst) {
			const occurrence = instantAt(day, minutes, timeZone);
			if (occurrence <= at) return occurrence;
		}
	}
	return undefined;
}

/** Whether the schedule runs on `day`, a calendar date as midnight UTC. */
function runsOn(schedule: CalendarSchedule, day: number): boolean {
	const start = Date.parse(`${schedule.startsOn}T00:00:00Z`);
	if (day < start) return false;
	switch (schedule.repeat) {
		case "daily":
			return Math.round((day - start) / DAY_MS) % schedule.every === 0;
		case "weekly": {
			const weekday = WEEKDAYS[partsOf(day).weekDay];
			if (!weekday || !schedule.days.includes(weekday)) return false;
			const weeks = Math.round((mondayOf(day) - mondayOf(start)) / (DAY_MS * DAYS_PER_WEEK));
			return weeks % schedule.every === 0;
		}
		case "monthly": {
			const date = partsOf(day);
			const first = partsOf(start);
			const months = (date.year - first.year) * MONTHS_PER_YEAR + (date.month - first.month);
			if (months % schedule.every !== 0) return false;
			return schedule.dayOfMonth === "last"
				? partsOf(day + DAY_MS).day === 1
				: date.day === schedule.dayOfMonth;
		}
	}
}

/** The Monday of `day`'s week, so weeks are counted Monday to Sunday. */
function mondayOf(day: number): number {
	const daysSinceMonday = (partsOf(day).weekDay + DAYS_PER_WEEK - 1) % DAYS_PER_WEEK;
	return day - daysSinceMonday * DAY_MS;
}

/** A calendar day's year, month (from 1), day of the month and weekday (Sunday as 0). */
function partsOf(day: number) {
	return DateTime.toPartsUtc(DateTime.makeUnsafe(day));
}

/** The calendar date `at` falls on in `timeZone`, as midnight UTC on that date. */
function localDay(at: Date, timeZone: string): number {
	const { year, month, day } = DateTime.toParts(DateTime.makeZonedUnsafe(at, { timeZone }));
	return Date.UTC(year, month - 1, day);
}

/** The moment `minutes` past midnight on `day` is in `timeZone`. */
function instantAt(day: number, minutes: number, timeZone: string): Date {
	const { year, month, day: date } = partsOf(day);
	const wallClock = {
		year,
		month,
		day: date,
		hour: Math.floor(minutes / 60),
		minute: minutes % 60,
	};
	return DateTime.toDateUtc(
		DateTime.makeZonedUnsafe(wallClock, { timeZone, adjustForTimeZone: true }),
	);
}
