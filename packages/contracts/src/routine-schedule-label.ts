import type { CalendarSchedule, Weekday } from "./automations.ts";

/*
 * How a routine's picked timetable is worded where it is shown short, the same
 * in the app and on the website's demo of it.
 */

/** Each day's short name, Monday first. */
export const WEEKDAY_SHORT_NAMES = {
	mon: "Mon",
	tue: "Tue",
	wed: "Wed",
	thu: "Thu",
	fri: "Fri",
	sat: "Sat",
	sun: "Sun",
} as const satisfies Record<Weekday, string>;

const WEEK_ORDER = Object.keys(WEEKDAY_SHORT_NAMES) as Weekday[];
const WORKING_DAYS: readonly Weekday[] = ["mon", "tue", "wed", "thu", "fri"];

/** A time of day on the 24-hour clock without a leading zero, as the design writes it: "9:00", "18:30". */
export function formatTime(minutesPastMidnight: number): string {
	const hour = Math.floor(minutesPastMidnight / 60);
	const minute = minutesPastMidnight % 60;
	return `${hour}:${String(minute).padStart(2, "0")}`;
}

/** How often, as the Every row says it: "1 day", "3 weeks". */
export function formatEvery(schedule: CalendarSchedule): string {
	const unit = { daily: "day", weekly: "week", monthly: "month" }[schedule.repeat];
	return `${schedule.every} ${unit}${schedule.every === 1 ? "" : "s"}`;
}

/** Whether `days` are Monday to Friday, and no others. */
export function isWorkingWeek(days: readonly Weekday[]): boolean {
	return days.length === WORKING_DAYS.length && WORKING_DAYS.every((day) => days.includes(day));
}

/** `days` in the week's order, Monday first. */
export function inWeekOrder(days: readonly Weekday[]): Weekday[] {
	return WEEK_ORDER.filter((day) => days.includes(day));
}

/** A picked timetable, short enough for a row's value: "Daily at 22:00", "Mon Thu at 8:00", "Weekdays, 3 times". */
export function calendarScheduleLabel(schedule: CalendarSchedule): string {
	const repeat = repeatLabel(schedule);
	const [onlyTime] = schedule.times;
	return schedule.times.length === 1 && onlyTime !== undefined
		? `${repeat} at ${formatTime(onlyTime)}`
		: `${repeat}, ${schedule.times.length} times`;
}

function repeatLabel(schedule: CalendarSchedule): string {
	if (schedule.every > 1) return `Every ${formatEvery(schedule)}`;
	switch (schedule.repeat) {
		case "daily":
			return "Daily";
		case "weekly":
			return isWorkingWeek(schedule.days)
				? "Weekdays"
				: inWeekOrder(schedule.days)
						.map((day) => WEEKDAY_SHORT_NAMES[day])
						.join(" ");
		case "monthly":
			return "Monthly";
	}
}
