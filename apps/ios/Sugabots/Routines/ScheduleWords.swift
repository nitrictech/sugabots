import Foundation

/// A routine's schedule as people pick and read it, as the web's
/// `lib/routine-schedule.ts`: every so many days, weeks or months, on some
/// days, at some times. A schedule written as cron is read into those parts
/// where it can be, and otherwise kept as written, by a name. A schedule of
/// a kind from a newer server than this app knows is kept as it is, by its kind.
enum ScheduleReading: Hashable {
	case picked(CalendarSchedule)
	case written(expression: String, label: String)
	case unrecognized(kind: String)

	var schedule: CalendarSchedule? {
		if case let .picked(schedule) = self { return schedule }
		return nil
	}
}

enum ScheduleWords {
	struct Day {
		let value: Weekday
		let letter: String
		let short: String
		let long: String
		let cron: String
	}

	static let days = [
		Day(value: .mon, letter: "M", short: "Mon", long: "Monday", cron: "1"),
		Day(value: .tue, letter: "T", short: "Tue", long: "Tuesday", cron: "2"),
		Day(value: .wed, letter: "W", short: "Wed", long: "Wednesday", cron: "3"),
		Day(value: .thu, letter: "T", short: "Thu", long: "Thursday", cron: "4"),
		Day(value: .fri, letter: "F", short: "Fri", long: "Friday", cron: "5"),
		Day(value: .sat, letter: "S", short: "Sat", long: "Saturday", cron: "6"),
		Day(value: .sun, letter: "S", short: "Sun", long: "Sunday", cron: "0"),
	]

	static let repeatOptions: [(value: CalendarSchedule.Repeat, label: String)] = [
		(.daily, "Daily"), (.weekly, "Weekly"), (.monthly, "Monthly"),
	]

	private static let weekdays: [Weekday] = [.mon, .tue, .wed, .thu, .fri]
	private static let minutesPerDay = 24 * 60
	/// How far a time added after the last one goes: far enough to be a different part of the day.
	private static let nextTimeGapMinutes = 4 * 60
	/// How far a new time steps aside from one already taken, and the times a day can be picked from.
	static let timeStepMinutes = 30
	/// The most of each unit a schedule can skip between runs.
	static func maxEvery(_ repeatKind: CalendarSchedule.Repeat) -> Int {
		switch repeatKind {
		case .daily: Limits.maxEveryDays
		case .weekly: Limits.maxEveryWeeks
		case .monthly: Limits.maxEveryMonths
		}
	}

	/// The day `now` falls on in this device's time zone, as `YYYY-MM-DD`.
	static func today(now: Date = .now) -> String {
		let parts = Calendar.current.dateComponents([.year, .month, .day], from: now)
		return String(format: "%04d-%02d-%02d", parts.year ?? 2000, parts.month ?? 1, parts.day ?? 1)
	}

	/// What a new routine runs on until somebody chooses: every day at 9:00, counted from the day of `now`.
	static func defaultSchedule(now: Date = .now) -> CalendarSchedule {
		CalendarSchedule(repeatKind: .daily, every: 1, times: [9 * 60], startsOn: today(now: now))
	}

	/// A stored schedule, read into its parts where they can say it; a cron expression read into parts counts from the day of `now`.
	static func read(_ schedule: TriggerSchedule, now: Date = .now) -> ScheduleReading {
		switch schedule {
		case let .calendar(picked): .picked(picked)
		case let .cron(expression): readCron(expression.trimmingCharacters(in: .whitespaces), now: now)
		case let .unknown(kind): .unrecognized(kind: kind)
		}
	}

	static func scheduleOf(_ reading: ScheduleReading) -> TriggerSchedule {
		switch reading {
		case let .picked(schedule): .calendar(schedule)
		case let .written(expression, _): .cron(expression)
		case let .unrecognized(kind): .unknown(kind: kind)
		}
	}

	/// Whether a picked schedule can run: a weekly one needs a day.
	static func ready(_ reading: ScheduleReading) -> Bool {
		guard let schedule = reading.schedule else { return true }
		return schedule.repeatKind != .weekly || !schedule.days.isEmpty
	}

	/// The schedule with `repeatKind` picked in its place: every back to 1, counted from the day of `now`; days and times stay.
	static func withRepeat(_ reading: ScheduleReading, _ repeatKind: CalendarSchedule.Repeat, now: Date = .now) -> CalendarSchedule {
		var schedule = CalendarSchedule(
			repeatKind: repeatKind,
			every: 1,
			times: reading.schedule?.times ?? defaultSchedule(now: now).times,
			startsOn: today(now: now)
		)
		switch repeatKind {
		case .daily: break
		case .weekly:
			schedule.days = reading.schedule?.repeatKind == .weekly ? reading.schedule?.days ?? [.mon] : [.mon]
		case .monthly:
			schedule.dayOfMonth = .day(min(Calendar.current.component(.day, from: now), 28))
		}
		return schedule
	}

	/// The time a new one starts at: some hours after the last, stepped past any taken.
	static func nextTime(_ times: [Int]) -> Int {
		var time = step(times.last ?? 9 * 60, by: nextTimeGapMinutes)
		while times.contains(time) { time = step(time, by: timeStepMinutes) }
		return time
	}

	/// Moves a time of day by `minutes`, round the clock either way.
	static func step(_ minutesPastMidnight: Int, by minutes: Int) -> Int {
		(((minutesPastMidnight + minutes) % minutesPerDay) + minutesPerDay) % minutesPerDay
	}

	/// "9:00", "18:30".
	static func formatTime(_ minutesPastMidnight: Int) -> String {
		String(format: "%d:%02d", minutesPastMidnight / 60, minutesPastMidnight % 60)
	}

	/// "1st", "22nd", or "last day".
	static func formatDayOfMonth(_ day: MonthDay) -> String {
		guard case let .day(number) = day else { return "last day" }
		let tens = number % 100
		let suffix = (11...13).contains(tens) ? "th" : [1: "st", 2: "nd", 3: "rd"][number % 10] ?? "th"
		return "\(number)\(suffix)"
	}

	/// "1 day", "3 weeks".
	static func formatEvery(_ schedule: CalendarSchedule) -> String {
		let unit = ["daily": "day", "weekly": "week", "monthly": "month"][schedule.repeatKind.rawValue] ?? "day"
		return "\(schedule.every) \(unit)\(schedule.every == 1 ? "" : "s")"
	}

	/// "every day at 9:00", "every 2 weeks on Mon and Thu at 9:00 and 17:30".
	static func summary(_ schedule: CalendarSchedule) -> String {
		let at = "at \(listOf(schedule.times.sorted().map(formatTime)))"
		switch schedule.repeatKind {
		case .daily:
			return "\(every(schedule.every, "day")) \(at)"
		case .weekly:
			if schedule.every == 1, isWeekdays(schedule.days) { return "every weekday \(at)" }
			return "\(every(schedule.every, "week")) on \(listOf(ordered(schedule.days).map(\.short))) \(at)"
		case .monthly:
			return "\(every(schedule.every, "month")) on the \(formatDayOfMonth(schedule.dayOfMonth)) \(at)"
		}
	}

	/// How a routine starts, short enough for a list's line: "Daily at 22:00", "Webhook +2".
	static func scheduleLabel(_ routine: Routine) -> String? {
		guard let first = routine.triggers.first else { return nil }
		let label = triggerLabel(first.input)
		return routine.triggers.count > 1 ? "\(label) +\(routine.triggers.count - 1)" : label
	}

	/// One trigger, short enough for a row: "Daily at 22:00", "Webhook", "On acme/web".
	static func triggerLabel(_ trigger: TriggerInput) -> String {
		switch trigger {
		case .webhook: "Webhook"
		case let .github(_, repository, _): "On \(repository)"
		case let .cron(schedule, _): readingLabel(read(schedule))
		}
	}

	/// "Daily at 22:00", "Mon Wed Fri, 3 times".
	static func readingLabel(_ reading: ScheduleReading) -> String {
		switch reading {
		case let .written(_, label):
			return label
		case .unrecognized:
			return customScheduleLabel
		case let .picked(schedule):
			return schedule.times.count == 1
				? "\(repeatLabel(schedule)) at \(formatTime(schedule.times[0]))"
				: "\(repeatLabel(schedule)), \(schedule.times.count) times"
		}
	}

	/// When the routine runs next on a schedule: "Today at 14:00", "Tomorrow at 7:00", "Mon at 9:00", "3 Nov at 10:00".
	static func nextRunAt(_ routine: Routine, now: Date = .now) -> String? {
		guard let next = routine.triggers.compactMap({ $0.kind == "cron" ? $0.nextScheduledAt : nil }).min() else { return nil }
		let calendar = Calendar.current
		let days = calendar.dateComponents([.day], from: calendar.startOfDay(for: now), to: calendar.startOfDay(for: next)).day ?? 0
		let day =
			days <= 0 ? "Today"
			: days == 1 ? "Tomorrow"
			: days < 7 ? next.formatted(.dateTime.weekday(.abbreviated))
			: next.formatted(.dateTime.day().month(.abbreviated))
		return "\(day) at \(Times.clock(next))"
	}

	/// When the routine runs next, in words: its soonest time on a schedule, or what starts it, if anything does.
	static func nextRunWords(_ routine: Routine) -> String? {
		if let next = nextRunAt(routine) {
			let lowered = next.hasPrefix("Today") || next.hasPrefix("Tomorrow") ? next.prefix(1).lowercased() + next.dropFirst() : next
			return "Next run \(lowered)"
		}
		if !routine.triggers.isEmpty, routine.triggers.allSatisfy({ $0.kind == "webhook" }) {
			return "Runs when its address is called"
		}
		return scheduleLabel(routine)
	}

	/// The note under a schedule: when it runs, and in which time zone.
	static func note(_ reading: ScheduleReading, timezone: String) -> String {
		let when = reading.schedule.map(summary) ?? "on its own schedule"
		return "Runs \(when), \(zoneName(timezone))."
	}

	/// "your time (AEDT)" for this device's zone, else "Los Angeles time (PDT)", or "UTC".
	static func zoneName(_ timezone: String) -> String {
		let zone = TimeZone(identifier: timezone)
		let abbreviation = zone?.abbreviation()
		if timezone == TimeZone.current.identifier {
			return abbreviation.map { "your time (\($0))" } ?? "your time"
		}
		let city = (timezone.split(separator: "/").last.map(String.init) ?? timezone).replacingOccurrences(of: "_", with: " ")
		guard let abbreviation, abbreviation != city else { return city }
		return "\(city) time (\(abbreviation))"
	}

	private static func repeatLabel(_ schedule: CalendarSchedule) -> String {
		if schedule.every > 1 { return "Every \(formatEvery(schedule))" }
		switch schedule.repeatKind {
		case .daily: return "Daily"
		case .weekly: return isWeekdays(schedule.days) ? "Weekdays" : ordered(schedule.days).map(\.short).joined(separator: " ")
		case .monthly: return "Monthly"
		}
	}

	private static func every(_ count: Int, _ unit: String) -> String {
		count == 1 ? "every \(unit)" : "every \(count) \(unit)s"
	}

	private static func listOf(_ items: [String]) -> String {
		guard items.count > 1 else { return items.joined() }
		return "\(items.dropLast().joined(separator: ", ")) and \(items[items.count - 1])"
	}

	private static func ordered(_ chosen: [Weekday]) -> [Day] {
		days.filter { chosen.contains($0.value) }
	}

	private static func isWeekdays(_ chosen: [Weekday]) -> Bool {
		chosen.count == weekdays.count && weekdays.allSatisfy(chosen.contains)
	}

	/// What a schedule that can't be read into its parts is called.
	private static let customScheduleLabel = "Custom schedule"

	/// A cron expression in parts, where it says times each day or on some days
	/// of the week; anything else is kept as written, by a name.
	private static func readCron(_ expression: String, now: Date) -> ScheduleReading {
		let fields = expression.split(whereSeparator: \.isWhitespace).map(String.init)
		let written = { (label: String) in ScheduleReading.written(expression: expression, label: label) }
		guard fields.count == 5, fields[2] == "*", fields[3] == "*" else { return written(customScheduleLabel) }
		let (minute, hour, dayOfWeek) = (fields[0], fields[1], fields[4])
		let digits = { (text: Substring) in !text.isEmpty && text.allSatisfy(\.isASCII) && text.allSatisfy(\.isNumber) }
		if digits(Substring(minute)), hour.hasSuffix("-23"), digits(hour.dropLast(3)), dayOfWeek == "*" {
			let from = (Int(hour.dropLast(3)) ?? 0) * 60 + (Int(minute) ?? 0)
			return written("Every hour from \(formatTime(from))")
		}
		let hours = hour.split(separator: ",", omittingEmptySubsequences: false)
		guard digits(Substring(minute)), hours.allSatisfy(digits), let minutes = Int(minute) else { return written(customScheduleLabel) }
		let times = hours.map { (Int($0) ?? minutesPerDay) * 60 + minutes }
		// Only times a picked schedule can hold: each once, and no more than it allows.
		guard times.allSatisfy({ $0 < minutesPerDay }), Set(times).count == times.count, times.count <= Limits.maxRoutineScheduleTimes else {
			return written(customScheduleLabel)
		}
		var schedule = CalendarSchedule(repeatKind: .daily, every: 1, times: times, startsOn: today(now: now))
		if dayOfWeek == "*" { return .picked(schedule) }
		let chosen: [Weekday]? =
			dayOfWeek == "1-5"
			? weekdays
			: dayOfWeek.split(separator: ",").map { day in
				days.first { $0.cron == (day == "7" ? "0" : String(day)) }?.value
			}.reduce([Weekday]?.some([])) { list, day in day.flatMap { day in list.map { $0 + [day] } } }
		guard let chosen else { return written(customScheduleLabel) }
		schedule.repeatKind = .weekly
		schedule.days = chosen
		return .picked(schedule)
	}
}
