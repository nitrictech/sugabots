const DAY_MS = 24 * 60 * 60 * 1000;
const WEEK_DAYS = 7;
const YESTERDAY = "Yesterday";

/**
 * When a message was sent, as a conversation list shows it: the time for
 * today, "Yesterday", the weekday within the week, then the date, with the
 * year only when it is not this one. Inside a sentence, use
 * {@link formatListTimeInSentence}.
 */
export function formatListTime(at: Date, now: Date, locale?: string): string {
	const daysAgo = Math.round((startOfDay(now) - startOfDay(at)) / DAY_MS);
	if (daysAgo <= 0) return formatClockTime(at, locale);
	if (daysAgo === 1) return YESTERDAY;
	if (daysAgo < WEEK_DAYS) return at.toLocaleDateString(locale, { weekday: "short" });
	return at.toLocaleDateString(locale, {
		day: "numeric",
		month: "short",
		year: at.getFullYear() === now.getFullYear() ? undefined : "numeric",
	});
}

/**
 * {@link formatListTime} for the middle of a sentence, such as "Last used
 * yesterday": only "Yesterday" is lowercased, since weekday and month names
 * keep their capitals ("Last used 2 Oct").
 */
export function formatListTimeInSentence(at: Date, now: Date, locale?: string): string {
	const shown = formatListTime(at, now, locale);
	return shown === YESTERDAY ? shown.toLowerCase() : shown;
}

/**
 * When something happened, to follow a verb such as "Sent": "at 6:12" today,
 * "yesterday", "on Sunday" within the week, then "on 2 Oct", with the year
 * only when it is not this one.
 */
export function formatTimeAfterVerb(at: Date, now: Date, locale?: string): string {
	const daysAgo = Math.round((startOfDay(now) - startOfDay(at)) / DAY_MS);
	if (daysAgo <= 0) return `at ${formatClockTime(at, locale)}`;
	if (daysAgo === 1) return "yesterday";
	if (daysAgo < WEEK_DAYS) return `on ${at.toLocaleDateString(locale, { weekday: "long" })}`;
	return `on ${at.toLocaleDateString(locale, {
		day: "numeric",
		month: "short",
		year: at.getFullYear() === now.getFullYear() ? undefined : "numeric",
	})}`;
}

/**
 * How long ago something happened, as a list's time column shows it: the time
 * for today, then whole days ("5d"), then whole months once a calendar month
 * has passed ("1m"), then whole years ("1y").
 */
export function formatAge(at: Date, now: Date, locale?: string): string {
	const daysAgo = Math.round((startOfDay(now) - startOfDay(at)) / DAY_MS);
	if (daysAgo <= 0) return formatClockTime(at, locale);
	const monthsAgo = wholeMonthsBetween(at, now);
	if (monthsAgo < 1) return `${daysAgo}d`;
	if (monthsAgo < MONTHS_IN_YEAR) return `${monthsAgo}m`;
	return `${Math.floor(monthsAgo / MONTHS_IN_YEAR)}y`;
}

const MONTHS_IN_YEAR = 12;

/** Calendar months from `from` to `to`, counting one only once its day of the month is reached. */
function wholeMonthsBetween(from: Date, to: Date): number {
	const months =
		(to.getFullYear() - from.getFullYear()) * MONTHS_IN_YEAR + to.getMonth() - from.getMonth();
	return to.getDate() < from.getDate() ? months - 1 : months;
}

/**
 * The hour and minute without an AM or PM, as the design writes times: "6:12".
 * The day beside it, or the conversation around it, makes the period plain.
 */
export function formatClockTime(at: Date, locale?: string): string {
	return new Intl.DateTimeFormat(locale, { hour: "numeric", minute: "2-digit" })
		.formatToParts(at)
		.filter((part) => part.type !== "dayPeriod")
		.map((part) => part.value)
		.join("")
		.trim();
}

/**
 * The day `at` falls on, as a chat's day marker says it: "Today",
 * "Yesterday", or the month and day, with the year only for another year.
 */
export function formatDay(at: Date): string {
	const now = new Date();
	const daysAgo = Math.round((startOfDay(now) - startOfDay(at)) / DAY_MS);
	if (daysAgo === 0) return "Today";
	if (daysAgo === 1) return YESTERDAY;
	return at.toLocaleDateString(undefined, {
		month: "short",
		day: "numeric",
		year: at.getFullYear() === now.getFullYear() ? undefined : "numeric",
	});
}

/** A date in full, as a profile says when something began: "14 Sep 2026". */
export function formatDate(at: Date): string {
	return at.toLocaleDateString(undefined, { day: "numeric", month: "short", year: "numeric" });
}

/**
 * When something will happen, by `now`: "Today at 14:00", "Tomorrow at 7:00",
 * "Mon at 9:00" within the week, then "14 Sep at 9:00".
 */
export function formatTimeAhead(at: Date, now: Date): string {
	const daysAhead = Math.round((startOfDay(at) - startOfDay(now)) / DAY_MS);
	const day =
		daysAhead <= 0
			? "Today"
			: daysAhead === 1
				? "Tomorrow"
				: daysAhead < WEEK_DAYS
					? at.toLocaleDateString(undefined, { weekday: "short" })
					: at.toLocaleDateString(undefined, { day: "numeric", month: "short" });
	return `${day} at ${formatClockTime(at)}`;
}

/** When something happened, to the second, as a time's tooltip gives it: "Today at 9:14:05 AM". */
export function formatFullTimestamp(at: string): string {
	const date = new Date(at);
	const time = date.toLocaleTimeString(undefined, {
		hour: "numeric",
		minute: "2-digit",
		second: "2-digit",
	});
	return `${formatDay(date)} at ${time}`;
}

function startOfDay(date: Date): number {
	return new Date(date.getFullYear(), date.getMonth(), date.getDate()).getTime();
}
