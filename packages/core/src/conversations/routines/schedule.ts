import { CronExpressionParser } from "cron-parser";
import { Data, Effect } from "effect";

export class InvalidRoutineSchedule extends Data.TaggedError("InvalidRoutineSchedule")<{
	readonly detail: string;
}> {
	override get message() {
		return this.detail;
	}
}

export function upcomingOccurrences(
	expression: string,
	timezone: string,
	count = 5,
	from = new Date(),
): Effect.Effect<Date[], InvalidRoutineSchedule> {
	return Effect.try({
		try: () => {
			if (expression.trim().split(/\s+/).length !== 5) {
				throw new Error("Use a five-field cron expression");
			}
			new Intl.DateTimeFormat("en", { timeZone: timezone }).format(from);
			const interval = CronExpressionParser.parse(expression, {
				currentDate: from,
				tz: timezone,
			});
			return Array.from({ length: count }, () => interval.next().toDate());
		},
		catch: (cause) =>
			new InvalidRoutineSchedule({
				detail: cause instanceof Error ? cause.message : "That schedule is invalid",
			}),
	});
}

export const nextOccurrence = (expression: string, timezone: string, from = new Date()) =>
	Effect.map(upcomingOccurrences(expression, timezone, 1, from), ([next]) => {
		if (!next) throw new Error("Cron parser returned no next occurrence");
		return next;
	});

export function latestMissedAndNextOccurrence(
	expression: string,
	timezone: string,
	now = new Date(),
): Effect.Effect<{ latest: Date; next: Date }, InvalidRoutineSchedule> {
	return Effect.try({
		try: () => {
			if (expression.trim().split(/\s+/).length !== 5) {
				throw new Error("Use a five-field cron expression");
			}
			new Intl.DateTimeFormat("en", { timeZone: timezone }).format(now);
			const latest = CronExpressionParser.parse(expression, {
				currentDate: new Date(now.getTime() + 1),
				tz: timezone,
			})
				.prev()
				.toDate();
			const next = CronExpressionParser.parse(expression, { currentDate: now, tz: timezone })
				.next()
				.toDate();
			return { latest, next };
		},
		catch: (cause) =>
			new InvalidRoutineSchedule({
				detail: cause instanceof Error ? cause.message : "That schedule is invalid",
			}),
	});
}
