import type { RoutineSchedule } from "@sugabots/contracts";
import { type UserText, userText } from "@sugabots/errors";
import { CronExpressionParser } from "cron-parser";
import { Data, Effect } from "effect";
import type { UserFacing } from "../../user-message.ts";
import { calendarLatestAtOrBefore, calendarOccurrencesAfter } from "./calendar.ts";

/** A schedule that cannot run. People are told what to fix in our words, not the cron parser's. */
export class InvalidRoutineSchedule
	extends Data.TaggedError("InvalidRoutineSchedule")<{
		readonly reason: ScheduleProblem;
		/** What the cron parser threw, when it refused the expression. */
		readonly cause?: unknown;
	}>
	implements UserFacing
{
	override get message() {
		return `Invalid routine schedule: ${this.reason}`;
	}
	get userMessage() {
		return SCHEDULE_PROBLEM_USER_MESSAGES[this.reason];
	}
}

type ScheduleProblem = "notFiveFields" | "unknownTimeZone" | "unparseable" | "neverRuns";

const SCHEDULE_PROBLEM_USER_MESSAGES: Record<ScheduleProblem, UserText> = {
	notFiveFields: userText`Use a five-field cron expression`,
	unknownTimeZone: userText`That time zone is not recognised`,
	unparseable: userText`That cron expression is invalid`,
	neverRuns: userText`That schedule never runs`,
};

function requireTimeZone(timezone: string) {
	if (!Intl.supportedValuesOf("timeZone").includes(timezone) && timezone !== "UTC") {
		throw new InvalidRoutineSchedule({ reason: "unknownTimeZone" });
	}
}

function requireFiveFields(expression: string) {
	if (expression.trim().split(/\s+/).length !== 5) {
		throw new InvalidRoutineSchedule({ reason: "notFiveFields" });
	}
}

const unparseable = (cause: unknown) =>
	cause instanceof InvalidRoutineSchedule
		? cause
		: new InvalidRoutineSchedule({ reason: "unparseable", cause });

/** The schedule's next `count` runs after `from`, in `timezone`. */
export function upcomingOccurrences(
	schedule: RoutineSchedule,
	timezone: string,
	from: Date,
	count = 5,
): Effect.Effect<Date[], InvalidRoutineSchedule> {
	return Effect.try({
		try: () => {
			requireTimeZone(timezone);
			if (schedule.repeat !== "cron") {
				return calendarOccurrencesAfter(schedule, timezone, from, count);
			}
			requireFiveFields(schedule.expression);
			const interval = CronExpressionParser.parse(schedule.expression, {
				currentDate: from,
				tz: timezone,
			});
			return Array.from({ length: count }, () => interval.next().toDate());
		},
		catch: unparseable,
	});
}

/** The schedule's next run after `from`. A schedule that never runs again is refused. */
export const nextOccurrence = (schedule: RoutineSchedule, timezone: string, from: Date) =>
	Effect.flatMap(upcomingOccurrences(schedule, timezone, from, 1), ([next]) =>
		next ? Effect.succeed(next) : Effect.fail(new InvalidRoutineSchedule({ reason: "neverRuns" })),
	);

/**
 * The run that fell due last, at or before `now`, and the one after it: so
 * after downtime only the latest missed run happens. When the schedule has
 * no run lately, as after it was changed, the latest is `now`.
 */
export function latestMissedAndNextOccurrence(
	schedule: RoutineSchedule,
	timezone: string,
	now: Date,
): Effect.Effect<{ latest: Date; next: Date }, InvalidRoutineSchedule> {
	if (schedule.repeat !== "cron") {
		return Effect.map(nextOccurrence(schedule, timezone, now), (next) => ({
			latest: calendarLatestAtOrBefore(schedule, timezone, now) ?? now,
			next,
		}));
	}
	const { expression } = schedule;
	return Effect.try({
		try: () => {
			requireTimeZone(timezone);
			requireFiveFields(expression);
			const latest = CronExpressionParser.parse(expression, {
				currentDate: now.getTime() + 1,
				tz: timezone,
			})
				.prev()
				.toDate();
			const next = CronExpressionParser.parse(expression, { currentDate: now, tz: timezone })
				.next()
				.toDate();
			return { latest, next };
		},
		catch: unparseable,
	});
}
