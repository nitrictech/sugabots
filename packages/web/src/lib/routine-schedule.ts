import {
	type Automation,
	type AutomationTriggerInput,
	type CalendarSchedule,
	MAX_ROUTINE_TIMES,
	type Routine,
	type Weekday,
} from "@sugabots/contracts";
import {
	calendarScheduleLabel,
	formatTime,
	inWeekOrder,
	isWorkingWeek,
	WEEKDAY_SHORT_NAMES,
} from "@sugabots/contracts/routine-schedule-label";
import { listNames } from "@/lib/name-list.ts";

/*
 * A routine's timetable as members pick and read it: every so many days, weeks
 * or months, on some days, at some times. A routine stored as cron is read
 * into those parts where it says something they can say, and is otherwise
 * kept as written, by a name, until somebody picks a repeat in its place.
 */

export const DAY_OPTIONS = [
	{ value: "mon", letter: "M", long: "Monday", cron: "1" },
	{ value: "tue", letter: "T", long: "Tuesday", cron: "2" },
	{ value: "wed", letter: "W", long: "Wednesday", cron: "3" },
	{ value: "thu", letter: "T", long: "Thursday", cron: "4" },
	{ value: "fri", letter: "F", long: "Friday", cron: "5" },
	{ value: "sat", letter: "S", long: "Saturday", cron: "6" },
	{ value: "sun", letter: "S", long: "Sunday", cron: "0" },
] as const satisfies readonly {
	value: Weekday;
	letter: string;
	long: string;
	cron: string;
}[];

export const REPEAT_OPTIONS = [
	{ value: "daily", label: "Daily" },
	{ value: "weekly", label: "Weekly" },
	{ value: "monthly", label: "Monthly" },
] as const;

type Repeat = CalendarSchedule["repeat"];

const WEEKDAYS: readonly Weekday[] = ["mon", "tue", "wed", "thu", "fri"];
const MINUTES_PER_DAY = 24 * 60;
/** How far a time added after the last one goes: far enough to be a different part of the day. */
const NEXT_TIME_GAP_MINUTES = 4 * 60;
/** How far − and + move a time, and how far a new time steps aside from one already taken. */
export const TIME_STEP_MINUTES = 30;

export type RoutineReading =
	| { kind: "picked"; schedule: CalendarSchedule }
	| { kind: "written"; expression: string; label: string };

/** Today in this browser, as `YYYY-MM-DD`, which a schedule counts its days, weeks or months from. */
export function today(): string {
	const now = new Date();
	return `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, "0")}-${String(now.getDate()).padStart(2, "0")}`;
}

/** What a new automation runs on until somebody chooses: every day at 9:00. */
export function defaultSchedule(): CalendarSchedule {
	return { repeat: "daily", every: 1, times: [9 * 60], startsOn: today() };
}

/** A stored schedule, read into its parts where they can say it. */
export function readSchedule(schedule: Routine): RoutineReading {
	if (schedule.repeat !== "cron") return { kind: "picked", schedule };
	return readCron(schedule.expression.trim());
}

/** The schedule an automation saves: the one picked, or the written one kept as it was. */
export function scheduleOfReading(reading: RoutineReading): Routine {
	return reading.kind === "picked"
		? reading.schedule
		: { repeat: "cron", expression: reading.expression };
}

/** Whether a picked schedule can run: a weekly one needs a day. */
export function scheduleReady(reading: RoutineReading): boolean {
	return (
		reading.kind === "written" ||
		reading.schedule.repeat !== "weekly" ||
		reading.schedule.days.length > 0
	);
}

/**
 * The schedule with `repeat` picked in place of what it was. Every starts
 * again at 1, and the count starts from today; days and times stay.
 */
export function withRepeat(reading: RoutineReading, repeat: Repeat): CalendarSchedule {
	const times = reading.kind === "picked" ? reading.schedule.times : defaultSchedule().times;
	const base = { every: 1, times, startsOn: today() };
	switch (repeat) {
		case "daily":
			return { repeat, ...base };
		case "weekly":
			return {
				repeat,
				...base,
				days:
					reading.kind === "picked" && reading.schedule.repeat === "weekly"
						? reading.schedule.days
						: ["mon"],
			};
		case "monthly":
			return { repeat, ...base, dayOfMonth: Math.min(new Date().getDate(), 28) };
	}
}

/** The time a new one starts at: some hours after the last, stepped past any taken. */
export function nextTime(times: readonly number[]): number {
	let time = stepTime(times[times.length - 1] ?? 9 * 60, NEXT_TIME_GAP_MINUTES);
	while (times.includes(time)) time = stepTime(time, TIME_STEP_MINUTES);
	return time;
}

export function canAddTime(times: readonly number[]): boolean {
	return times.length < MAX_ROUTINE_TIMES;
}

/** Moves a time of day by `step` minutes, round the clock either way. */
function stepTime(minutesPastMidnight: number, step: number): number {
	return (((minutesPastMidnight + step) % MINUTES_PER_DAY) + MINUTES_PER_DAY) % MINUTES_PER_DAY;
}

/** "1st", "22nd", or "last day" for the end of the month. */
export function formatDayOfMonth(dayOfMonth: number | "last"): string {
	if (dayOfMonth === "last") return "last day";
	const tens = dayOfMonth % 100;
	const suffix =
		tens >= 11 && tens <= 13 ? "th" : ({ 1: "st", 2: "nd", 3: "rd" }[dayOfMonth % 10] ?? "th");
	return `${dayOfMonth}${suffix}`;
}

/**
 * When a picked schedule runs, as the middle of a sentence: "every day at
 * 9:00", "every 2 weeks on Mon and Thu at 9:00 and 17:30", "every month on
 * the last day at 10:00".
 */
export function scheduleSummary(schedule: CalendarSchedule): string {
	const at = `at ${listNames(sortedTimes(schedule.times).map(formatTime), { maxNamed: Infinity })}`;
	switch (schedule.repeat) {
		case "daily":
			return `${every(schedule.every, "day")} ${at}`;
		case "weekly":
			if (schedule.every === 1 && isWorkingWeek(schedule.days)) return `every weekday ${at}`;
			return `${every(schedule.every, "week")} on ${listNames(
				inWeekOrder(schedule.days).map((day) => WEEKDAY_SHORT_NAMES[day]),
				{ maxNamed: Infinity },
			)} ${at}`;
		case "monthly":
			return `${every(schedule.every, "month")} on the ${formatDayOfMonth(schedule.dayOfMonth)} ${at}`;
	}
}

/**
 * How an automation starts, short enough for a list's line: its first routine
 * or trigger, and how many more it has: "Daily at 22:00", "Webhook +2".
 * Nothing for one with neither, which runs only when somebody runs it.
 */
export function automationStartsLabel(automation: Automation): string | undefined {
	const [first, ...more] = automation.triggers;
	if (!first) return undefined;
	return more.length > 0 ? `${triggerLabel(first)} +${more.length}` : triggerLabel(first);
}

/**
 * One routine or trigger, short enough for a row: "Daily at 22:00", "Mon Wed
 * Fri, 3 times", "Every 3 months at 10:00", "Webhook", "On acme/web".
 */
export function triggerLabel(trigger: AutomationTriggerInput): string {
	switch (trigger.kind) {
		case "webhook":
			return "Webhook";
		case "github":
			return `On ${trigger.repository}`;
		case "routine":
			return readingLabel(readSchedule(trigger.schedule));
	}
}

/** A schedule, short enough for a row's value: "Daily at 22:00", "Mon Wed Fri, 3 times". */
function readingLabel(reading: RoutineReading): string {
	return reading.kind === "written" ? reading.label : calendarScheduleLabel(reading.schedule);
}

function every(count: number, unit: string): string {
	return count === 1 ? `every ${unit}` : `every ${count} ${unit}s`;
}

function sortedTimes(times: readonly number[]): number[] {
	return [...times].sort((a, b) => a - b);
}

/**
 * A cron expression in parts, where it says times each day or on some days
 * of the week; anything else is kept as written, by a name.
 */
function readCron(expression: string): RoutineReading {
	const [minute, hour, dayOfMonth, month, dayOfWeek, ...rest] = expression.split(/\s+/);
	const written = (label: string): RoutineReading => ({ kind: "written", expression, label });
	if (!minute || !hour || !dayOfWeek || dayOfMonth !== "*" || month !== "*" || rest.length > 0) {
		return written("Custom schedule");
	}
	if (/^\d+$/.test(minute) && /^\d+-23$/.test(hour) && dayOfWeek === "*") {
		const from = Number(hour.split("-")[0]) * 60 + Number(minute);
		return written(`Every hour from ${formatTime(from)}`);
	}
	if (!/^\d+$/.test(minute) || !/^\d+(?:,\d+)*$/.test(hour)) return written("Custom schedule");
	const times = hour.split(",").map((each) => Number(each) * 60 + Number(minute));
	// Only times a picked schedule can hold: each once, and no more than it allows.
	if (
		times.some((time) => time >= MINUTES_PER_DAY) ||
		new Set(times).size < times.length ||
		times.length > MAX_ROUTINE_TIMES
	) {
		return written("Custom schedule");
	}
	const base = { every: 1, times, startsOn: today() };
	if (dayOfWeek === "*") return { kind: "picked", schedule: { repeat: "daily", ...base } };
	const days = dayOfWeek === "1-5" ? WEEKDAYS : cronDays(dayOfWeek);
	if (!days) return written("Custom schedule");
	return { kind: "picked", schedule: { repeat: "weekly", ...base, days } };
}

function cronDays(field: string): Weekday[] | undefined {
	const days = field
		.split(",")
		.map((day) => DAY_OPTIONS.find((option) => option.cron === (day === "7" ? "0" : day))?.value);
	return days.every((day): day is Weekday => day !== undefined) ? days : undefined;
}
