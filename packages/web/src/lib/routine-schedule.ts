import type { Routine } from "@sugabots/contracts";

/*
 * A routine's schedule as people read and pick it: three repeats over the cron
 * expression the API stores, and the words for one ("Weekdays at 8:00"). A
 * cron expression the repeats cannot say is read as `other` and kept as it is
 * until somebody picks a repeat in its place.
 */

export const DAY_OPTIONS = [
	{ letter: "M", long: "Monday", cron: "1" },
	{ letter: "T", long: "Tuesday", cron: "2" },
	{ letter: "W", long: "Wednesday", cron: "3" },
	{ letter: "T", long: "Thursday", cron: "4" },
	{ letter: "F", long: "Friday", cron: "5" },
	{ letter: "S", long: "Saturday", cron: "6" },
	{ letter: "S", long: "Sunday", cron: "0" },
] as const;

export const REPEAT_OPTIONS = [
	{ value: "daily", label: "Every day" },
	{ value: "weekdays", label: "Weekdays" },
	{ value: "weekly", label: "Weekly" },
] as const;

type Repeat = (typeof REPEAT_OPTIONS)[number]["value"];

export interface Schedule {
	repeat: Repeat;
	/** Cron day numbers, Sunday as "0"; only read for `weekly`. */
	days: readonly string[];
	minutesPastMidnight: number;
}

export type ScheduleReading =
	| { kind: "preset"; schedule: Schedule }
	| { kind: "other"; expression: string; label: string };

const MINUTES_PER_DAY = 24 * 60;

export const DEFAULT_SCHEDULE: Schedule = {
	repeat: "daily",
	days: ["1"],
	minutesPastMidnight: 9 * 60,
};

export function readSchedule(expression: string): ScheduleReading {
	const trimmed = expression.trim();
	const [minute, hour, dayOfMonth, month, dayOfWeek, ...rest] = trimmed.split(/\s+/);
	const other = (label: string): ScheduleReading => ({ kind: "other", expression: trimmed, label });
	if (!minute || !hour || !dayOfWeek || dayOfMonth !== "*" || month !== "*" || rest.length > 0) {
		return other("Custom schedule");
	}
	if (/^\d+$/.test(minute) && /^\d+-23$/.test(hour) && dayOfWeek === "*") {
		const from = Number(hour.split("-")[0]) * 60 + Number(minute);
		return other(`Every hour from ${formatTime(from)}`);
	}
	if (!/^\d+$/.test(minute) || !/^\d+$/.test(hour)) return other("Custom schedule");
	const minutesPastMidnight = Number(hour) * 60 + Number(minute);
	if (minutesPastMidnight >= MINUTES_PER_DAY) return other("Custom schedule");
	if (dayOfWeek === "*") {
		return { kind: "preset", schedule: { repeat: "daily", days: [], minutesPastMidnight } };
	}
	if (dayOfWeek === "1-5") {
		return { kind: "preset", schedule: { repeat: "weekdays", days: [], minutesPastMidnight } };
	}
	const days = dayOfWeek.split(",").map((day) => (day === "7" ? "0" : day));
	if (!days.every((day) => DAY_OPTIONS.some((option) => option.cron === day))) {
		return other("Custom schedule");
	}
	return { kind: "preset", schedule: { repeat: "weekly", days, minutesPastMidnight } };
}

export function cronExpression({ repeat, days, minutesPastMidnight }: Schedule): string {
	const hour = Math.floor(minutesPastMidnight / 60);
	const minute = minutesPastMidnight % 60;
	if (repeat === "daily") return `${minute} ${hour} * * *`;
	if (repeat === "weekdays") return `${minute} ${hour} * * 1-5`;
	return `${minute} ${hour} * * ${orderedDays(days).join(",")}`;
}

/** "Every day at 6:00", "Weekdays at 8:00", "Mondays and Thursdays at 9:00". */
export function scheduleSummary({ repeat, days, minutesPastMidnight }: Schedule): string {
	const time = formatTime(minutesPastMidnight);
	if (repeat === "daily") return `Every day at ${time}`;
	if (repeat === "weekdays") return `Weekdays at ${time}`;
	const names = orderedDays(days).map(
		(value) => `${DAY_OPTIONS.find((day) => day.cron === value)?.long}s`,
	);
	if (names.length === 0) return "Pick at least one day";
	const last = names.pop();
	return `${names.length > 0 ? `${names.join(", ")} and ${last}` : last} at ${time}`;
}

/** How a routine starts, in the words its row shows. */
export function scheduleLabel(routine: Routine): string {
	if (routine.trigger.kind === "webhook") return "When its address is called";
	const reading = readSchedule(routine.trigger.expression);
	return reading.kind === "preset" ? scheduleSummary(reading.schedule) : reading.label;
}

function orderedDays(days: readonly string[]): string[] {
	return DAY_OPTIONS.map((day) => day.cron).filter((day) => days.includes(day));
}

export function hasDays(schedule: Schedule): boolean {
	return schedule.repeat !== "weekly" || schedule.days.length > 0;
}

/** A time of day on the 24-hour clock without a leading zero, as the design writes it: "9:00", "18:30". */
export function formatTime(minutesPastMidnight: number): string {
	const hour = Math.floor(minutesPastMidnight / 60);
	const minute = minutesPastMidnight % 60;
	return `${hour}:${String(minute).padStart(2, "0")}`;
}

/** Moves a time of day by `step` minutes, round the clock either way. */
export function stepTime(minutesPastMidnight: number, step: number): number {
	return (((minutesPastMidnight + step) % MINUTES_PER_DAY) + MINUTES_PER_DAY) % MINUTES_PER_DAY;
}
