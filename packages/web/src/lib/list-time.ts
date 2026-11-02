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

function startOfDay(date: Date): number {
	return new Date(date.getFullYear(), date.getMonth(), date.getDate()).getTime();
}
