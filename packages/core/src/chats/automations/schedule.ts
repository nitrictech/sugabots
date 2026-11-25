export { InvalidRoutineSchedule } from "@sugabots/contracts/errors/automations";

import type { Routine } from "@sugabots/contracts";
import { InvalidRoutineSchedule } from "@sugabots/contracts/errors/automations";
import { CronExpressionParser } from "cron-parser";
import { Effect } from "effect";
import { calendarLatestAtOrBefore, calendarOccurrencesAfter } from "./calendar.ts";

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

/** The timetable's next run after `from`. A timetable that never runs again is refused. */
export function nextOccurrence(
	schedule: Routine,
	timezone: string,
	from: Date,
): Effect.Effect<Date, InvalidRoutineSchedule> {
	return Effect.try({
		try: () => {
			requireTimeZone(timezone);
			if (schedule.repeat !== "cron") {
				return calendarOccurrencesAfter(schedule, timezone, from, 1)[0];
			}
			requireFiveFields(schedule.expression);
			return CronExpressionParser.parse(schedule.expression, { currentDate: from, tz: timezone })
				.next()
				.toDate();
		},
		catch: unparseable,
	}).pipe(
		Effect.flatMap((next) =>
			next
				? Effect.succeed(next)
				: Effect.fail(new InvalidRoutineSchedule({ reason: "neverRuns" })),
		),
	);
}

/**
 * The run that fell due last, at or before `now`, and the one after it: so
 * after downtime only the latest missed run happens. When the schedule has
 * no run lately, as after it was changed, the latest is `now`.
 */
export function latestMissedAndNextOccurrence(
	schedule: Routine,
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
