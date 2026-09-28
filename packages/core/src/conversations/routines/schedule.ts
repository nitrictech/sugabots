import { CronExpressionParser } from "cron-parser";
import { Data, Effect } from "effect";
import { type UserFacing, UserMessage } from "../../user-message.ts";

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

type ScheduleProblem = "notFiveFields" | "unknownTimeZone" | "unparseable";

const SCHEDULE_PROBLEM_USER_MESSAGES: Record<ScheduleProblem, UserMessage> = {
	notFiveFields: UserMessage.of`Use a five-field cron expression`,
	unknownTimeZone: UserMessage.of`That time zone is not recognised`,
	unparseable: UserMessage.of`That cron expression is invalid`,
};

function requireRunnable(expression: string, timezone: string) {
	if (expression.trim().split(/\s+/).length !== 5) {
		throw new InvalidRoutineSchedule({ reason: "notFiveFields" });
	}
	if (!Intl.supportedValuesOf("timeZone").includes(timezone) && timezone !== "UTC") {
		throw new InvalidRoutineSchedule({ reason: "unknownTimeZone" });
	}
}

const unparseable = (cause: unknown) =>
	cause instanceof InvalidRoutineSchedule
		? cause
		: new InvalidRoutineSchedule({ reason: "unparseable", cause });

export function upcomingOccurrences(
	expression: string,
	timezone: string,
	count = 5,
	from = new Date(),
): Effect.Effect<Date[], InvalidRoutineSchedule> {
	return Effect.try({
		try: () => {
			requireRunnable(expression, timezone);
			const interval = CronExpressionParser.parse(expression, {
				currentDate: from,
				tz: timezone,
			});
			return Array.from({ length: count }, () => interval.next().toDate());
		},
		catch: unparseable,
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
			requireRunnable(expression, timezone);
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
		catch: unparseable,
	});
}
