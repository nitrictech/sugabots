import Foundation

/// Times as the web's `list-time.ts` writes them, and the day a conversation
/// moves on to. Each takes the locale and calendar to write in, which are the
/// device's unless a check gives its own.
enum Times {
	private static let daysInWeek = 7
	private static let monthsInYear = 12
	private static let yesterday = "Yesterday"

	/// `6:12`: the hour and minute without AM or PM, as `formatClockTime`.
	/// The day beside it, or the conversation around it, makes the period plain.
	static func clock(_ date: Date, locale: Locale = .current, calendar: Calendar = .current) -> String {
		let formatter = DateFormatter()
		formatter.locale = locale
		formatter.calendar = calendar
		formatter.timeZone = calendar.timeZone
		formatter.setLocalizedDateFormatFromTemplate("jmm")
		return formatter.string(from: date)
			.replacingOccurrences(of: formatter.amSymbol, with: "")
			.replacingOccurrences(of: formatter.pmSymbol, with: "")
			.trimmingCharacters(in: .whitespaces)
	}

	/// As `formatListTime`: the time today, Yesterday, a weekday this week,
	/// then the date, with the year only when it isn't this one.
	static func list(_ date: Date, now: Date = .now, locale: Locale = .current, calendar: Calendar = .current) -> String {
		let days = daysAgo(date, now: now, calendar: calendar)
		if days <= 0 { return clock(date, locale: locale, calendar: calendar) }
		if days == 1 { return yesterday }
		let style = Date.FormatStyle(locale: locale, calendar: calendar, timeZone: calendar.timeZone)
		if days < daysInWeek { return date.formatted(style.weekday(.abbreviated)) }
		let sameYear = calendar.component(.year, from: date) == calendar.component(.year, from: now)
		return date.formatted(sameYear ? style.day().month(.abbreviated) : style.day().month(.abbreviated).year())
	}

	/// As `formatListTimeInSentence`: `list` for the middle of a sentence, such as
	/// "Last used yesterday". Only Yesterday is lowered; weekday and month names keep their capitals.
	static func listInSentence(_ date: Date, now: Date = .now, locale: Locale = .current, calendar: Calendar = .current) -> String {
		let shown = list(date, now: now, locale: locale, calendar: calendar)
		return shown == yesterday ? shown.lowercased() : shown
	}

	/// As `formatAge`: the time today, then whole days (`5d`), then whole
	/// months once a calendar month has passed (`1m`), then whole years (`1y`).
	static func age(_ date: Date, now: Date = .now, locale: Locale = .current, calendar: Calendar = .current) -> String {
		let days = daysAgo(date, now: now, calendar: calendar)
		if days <= 0 { return clock(date, locale: locale, calendar: calendar) }
		let months = wholeMonths(from: date, to: now, calendar)
		if months < 1 { return "\(days)d" }
		if months < monthsInYear { return "\(months)m" }
		return "\(months / monthsInYear)y"
	}

	/// `Today`, `Yesterday`, `Mar 3`, or `Mar 3, 2025` in another year: where a conversation moves on to a new day, as `formatDay`.
	static func day(_ date: Date, now: Date = .now, locale: Locale = .current, calendar: Calendar = .current) -> String {
		let days = daysAgo(date, now: now, calendar: calendar)
		if days == 0 { return "Today" }
		if days == 1 { return yesterday }
		let sameYear = calendar.component(.year, from: date) == calendar.component(.year, from: now)
		let style = Date.FormatStyle(locale: locale, calendar: calendar, timeZone: calendar.timeZone).month(.abbreviated).day()
		return date.formatted(sameYear ? style : style.year())
	}

	/// How long ago `date` was, as `formatDistanceToNowStrict` with `addSuffix`
	/// writes it: one unit, the largest under its next, rounded to the nearest
	/// whole one ("4 minutes ago", "18 days ago", "6 months ago"). Days run to
	/// 30 and months to 12, with no weeks; a time after `now` is "in 1 second".
	static func ago(_ date: Date, now: Date = .now) -> String {
		let seconds = now.timeIntervalSince(date)
		let words = distance(abs(seconds))
		return seconds < 0 ? "in \(words)" : "\(words) ago"
	}

	private static let secondsInMinute = 60.0
	private static let secondsInHour = 60 * secondsInMinute
	private static let secondsInDay = 24 * secondsInHour
	private static let secondsInMonth = 30 * secondsInDay
	private static let secondsInYear = 365 * secondsInDay

	private static func distance(_ seconds: TimeInterval) -> String {
		func count(_ amount: Double, _ unit: String) -> String {
			let whole = Int(amount.rounded())
			return whole == 1 ? "1 \(unit)" : "\(whole) \(unit)s"
		}
		if seconds < secondsInMinute { return count(seconds, "second") }
		if seconds < secondsInHour { return count(seconds / secondsInMinute, "minute") }
		if seconds < secondsInDay { return count(seconds / secondsInHour, "hour") }
		if seconds < secondsInMonth { return count(seconds / secondsInDay, "day") }
		if seconds < secondsInYear {
			let months = (seconds / secondsInMonth).rounded()
			return months == Double(monthsInYear) ? "1 year" : count(months, "month")
		}
		return count(seconds / secondsInYear, "year")
	}

	/// How many days before `now`'s day `date`'s day is: 0 today, 1 yesterday, negative in the future.
	static func daysAgo(_ date: Date, now: Date = .now, calendar: Calendar = .current) -> Int {
		calendar.dateComponents([.day], from: calendar.startOfDay(for: date), to: calendar.startOfDay(for: now)).day ?? 0
	}

	/// Calendar months from `from` to `to`, counting one only once its day of the month is reached.
	private static func wholeMonths(from: Date, to: Date, _ calendar: Calendar) -> Int {
		let (start, end) = (calendar.dateComponents([.year, .month, .day], from: from), calendar.dateComponents([.year, .month, .day], from: to))
		let months = ((end.year ?? 0) - (start.year ?? 0)) * monthsInYear + (end.month ?? 0) - (start.month ?? 0)
		return (end.day ?? 0) < (start.day ?? 0) ? months - 1 : months
	}
}
