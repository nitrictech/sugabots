import {
	type CalendarSchedule,
	MAX_ROUTINE_SCHEDULE_TIMES,
	type Routine,
	type RoutineSchedule,
	type RoutineTriggerInput,
	type Weekday,
} from "@sugabots/contracts";
import { formatClockTime } from "@/lib/list-time.ts";

/*
 * A routine's schedule as people pick and read it: every so many days, weeks
 * or months, on some days, at some times. A schedule written as cron before
 * schedules were picked this way is read into those parts where it says
 * something they can say, and is otherwise kept as written, by a name, until
 * somebody picks a repeat in its place.
 */

export const DAY_OPTIONS = [
	{ value: "mon", letter: "M", short: "Mon", long: "Monday", cron: "1" },
	{ value: "tue", letter: "T", short: "Tue", long: "Tuesday", cron: "2" },
	{ value: "wed", letter: "W", short: "Wed", long: "Wednesday", cron: "3" },
	{ value: "thu", letter: "T", short: "Thu", long: "Thursday", cron: "4" },
	{ value: "fri", letter: "F", short: "Fri", long: "Friday", cron: "5" },
	{ value: "sat", letter: "S", short: "Sat", long: "Saturday", cron: "6" },
	{ value: "sun", letter: "S", short: "Sun", long: "Sunday", cron: "0" },
] as const satisfies readonly {
	value: Weekday;
	letter: string;
	short: string;
	long: string;
	cron: string;
}[];

export const REPEAT_OPTIONS = [
	{ value: "daily", label: "Daily" },
	{ value: "weekly", label: "Weekly" },
	{ value: "monthly", label: "Monthly" },
] as const;

export type Repeat = CalendarSchedule["repeat"];

const WEEKDAYS: readonly Weekday[] = ["mon", "tue", "wed", "thu", "fri"];
const MINUTES_PER_DAY = 24 * 60;
/** How far a time added after the last one goes: far enough to be a different part of the day. */
const NEXT_TIME_GAP_MINUTES = 4 * 60;
/** How far − and + move a time, and how far a new time steps aside from one already taken. */
export const TIME_STEP_MINUTES = 30;

export type ScheduleReading =
	| { kind: "picked"; schedule: CalendarSchedule }
	| { kind: "written"; expression: string; label: string };

/** Today in this browser, as `YYYY-MM-DD`, which a schedule counts its days, weeks or months from. */
export function today(): string {
	const now = new Date();
	return `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, "0")}-${String(now.getDate()).padStart(2, "0")}`;
}

/** What a new routine runs on until somebody chooses: every day at 9:00. */
export function defaultSchedule(): CalendarSchedule {
	return { repeat: "daily", every: 1, times: [9 * 60], startsOn: today() };
}

/** A stored schedule, read into its parts where they can say it. */
export function readSchedule(schedule: RoutineSchedule): ScheduleReading {
	if (schedule.repeat !== "cron") return { kind: "picked", schedule };
	return readCron(schedule.expression.trim());
}

/** The schedule a routine saves: the one picked, or the written one kept as it was. */
export function scheduleOfReading(reading: ScheduleReading): RoutineSchedule {
	return reading.kind === "picked"
		? reading.schedule
		: { repeat: "cron", expression: reading.expression };
}

/** Whether a picked schedule can run: a weekly one needs a day. */
export function scheduleReady(reading: ScheduleReading): boolean {
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
export function withRepeat(reading: ScheduleReading, repeat: Repeat): CalendarSchedule {
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
	return times.length < MAX_ROUTINE_SCHEDULE_TIMES;
}

/** Moves a time of day by `step` minutes, round the clock either way. */
export function stepTime(minutesPastMidnight: number, step: number): number {
	return (((minutesPastMidnight + step) % MINUTES_PER_DAY) + MINUTES_PER_DAY) % MINUTES_PER_DAY;
}

/** A time of day on the 24-hour clock without a leading zero, as the design writes it: "9:00", "18:30". */
export function formatTime(minutesPastMidnight: number): string {
	const hour = Math.floor(minutesPastMidnight / 60);
	const minute = minutesPastMidnight % 60;
	return `${hour}:${String(minute).padStart(2, "0")}`;
}

/** "1st", "22nd", or "last day" for the end of the month. */
export function formatDayOfMonth(dayOfMonth: number | "last"): string {
	if (dayOfMonth === "last") return "last day";
	const tens = dayOfMonth % 100;
	const suffix =
		tens >= 11 && tens <= 13 ? "th" : ({ 1: "st", 2: "nd", 3: "rd" }[dayOfMonth % 10] ?? "th");
	return `${dayOfMonth}${suffix}`;
}

/** How often, as the Every row says it: "1 day", "3 weeks". */
export function formatEvery(schedule: CalendarSchedule): string {
	const unit = { daily: "day", weekly: "week", monthly: "month" }[schedule.repeat];
	return `${schedule.every} ${unit}${schedule.every === 1 ? "" : "s"}`;
}

/**
 * When a picked schedule runs, as the middle of a sentence: "every day at
 * 9:00", "every 2 weeks on Mon and Thu at 9:00 and 17:30", "every month on
 * the last day at 10:00".
 */
export function scheduleSummary(schedule: CalendarSchedule): string {
	const at = `at ${listOf(sortedTimes(schedule.times).map(formatTime))}`;
	switch (schedule.repeat) {
		case "daily":
			return `${every(schedule.every, "day")} ${at}`;
		case "weekly":
			if (schedule.every === 1 && isWeekdays(schedule.days)) return `every weekday ${at}`;
			return `${every(schedule.every, "week")} on ${listOf(orderedDays(schedule.days).map((day) => day.short))} ${at}`;
		case "monthly":
			return `${every(schedule.every, "month")} on the ${formatDayOfMonth(schedule.dayOfMonth)} ${at}`;
	}
}

/**
 * How a routine starts, short enough for a list's line: its first trigger,
 * and how many more it has: "Daily at 22:00", "Webhook +2". Nothing for one
 * with no trigger, which runs only when somebody runs it.
 */
export function scheduleLabel(routine: Routine): string | undefined {
	const [first, ...more] = routine.triggers;
	if (!first) return undefined;
	return more.length > 0 ? `${triggerLabel(first)} +${more.length}` : triggerLabel(first);
}

/**
 * One trigger, short enough for a row: "Daily at 22:00", "Mon Wed Fri, 3
 * times", "Every 3 months at 10:00", "Webhook", "On acme/web".
 */
export function triggerLabel(trigger: RoutineTriggerInput): string {
	switch (trigger.kind) {
		case "webhook":
			return "Webhook";
		case "github":
			return `On ${trigger.repository}`;
		case "cron":
			return readingLabel(readSchedule(trigger.schedule));
	}
}

/** A schedule, short enough for a row's value: "Daily at 22:00", "Mon Wed Fri, 3 times". */
export function readingLabel(reading: ScheduleReading): string {
	if (reading.kind === "written") return reading.label;
	const { schedule } = reading;
	return schedule.times.length === 1
		? `${repeatLabel(schedule)} at ${formatTime(schedule.times[0] ?? 0)}`
		: `${repeatLabel(schedule)}, ${schedule.times.length} times`;
}

function repeatLabel(schedule: CalendarSchedule): string {
	if (schedule.every > 1) return `Every ${formatEvery(schedule)}`;
	switch (schedule.repeat) {
		case "daily":
			return "Daily";
		case "weekly":
			return isWeekdays(schedule.days)
				? "Weekdays"
				: orderedDays(schedule.days)
						.map((day) => day.short)
						.join(" ");
		case "monthly":
			return "Monthly";
	}
}

function every(count: number, unit: string): string {
	return count === 1 ? `every ${unit}` : `every ${count} ${unit}s`;
}

function listOf(items: readonly string[]): string {
	if (items.length <= 1) return items.join("");
	return `${items.slice(0, -1).join(", ")} and ${items[items.length - 1]}`;
}

function sortedTimes(times: readonly number[]): number[] {
	return [...times].sort((a, b) => a - b);
}

function orderedDays(days: readonly Weekday[]) {
	return DAY_OPTIONS.filter((day) => days.includes(day.value));
}

function isWeekdays(days: readonly Weekday[]): boolean {
	return days.length === WEEKDAYS.length && WEEKDAYS.every((day) => days.includes(day));
}

/**
 * A cron expression in parts, where it says a time each day or on some days
 * of the week; anything else is kept as written, by a name.
 */
function readCron(expression: string): ScheduleReading {
	const [minute, hour, dayOfMonth, month, dayOfWeek, ...rest] = expression.split(/\s+/);
	const written = (label: string): ScheduleReading => ({ kind: "written", expression, label });
	if (!minute || !hour || !dayOfWeek || dayOfMonth !== "*" || month !== "*" || rest.length > 0) {
		return written("Custom schedule");
	}
	if (/^\d+$/.test(minute) && /^\d+-23$/.test(hour) && dayOfWeek === "*") {
		const from = Number(hour.split("-")[0]) * 60 + Number(minute);
		return written(`Every hour from ${formatTime(from)}`);
	}
	if (!/^\d+$/.test(minute) || !/^\d+$/.test(hour)) return written("Custom schedule");
	const time = Number(hour) * 60 + Number(minute);
	if (time >= MINUTES_PER_DAY) return written("Custom schedule");
	const base = { every: 1, times: [time], startsOn: today() };
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

/** When the routine runs next on a schedule, in words: "Today at 14:00", "Tomorrow at 7:00", "Mon at 9:00"; none off a schedule. */
export function nextRunAt(routine: Routine, now = new Date()): string | undefined {
	const [next] = routine.triggers
		.flatMap((trigger) =>
			trigger.kind === "cron" && trigger.nextScheduledAt ? [trigger.nextScheduledAt] : [],
		)
		.sort();
	if (!next) return undefined;
	const at = new Date(next);
	const daysAhead = Math.round(
		(new Date(at).setHours(0, 0, 0, 0) - new Date(now).setHours(0, 0, 0, 0)) / 86_400_000,
	);
	const day =
		daysAhead <= 0
			? "Today"
			: daysAhead === 1
				? "Tomorrow"
				: daysAhead < 7
					? at.toLocaleDateString(undefined, { weekday: "short" })
					: at.toLocaleDateString(undefined, { day: "numeric", month: "short" });
	return `${day} at ${formatClockTime(at)}`;
}

/** When the routine runs next, in words: its soonest time on a schedule, or what starts it, if anything does. */
export function nextRunWords(routine: Routine): string | undefined {
	const next = nextRunAt(routine);
	if (next) return `Next run ${next.replace(/^(Today|Tomorrow)/, (day) => day.toLowerCase())}`;
	if (routine.triggers.length > 0 && routine.triggers.every(({ kind }) => kind === "webhook")) {
		return "Runs when its address is called";
	}
	return scheduleLabel(routine);
}
