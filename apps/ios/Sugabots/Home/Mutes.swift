import Foundation

/// How long a pause or a mute lasts, as Slack offers them; `all`, generated
/// from the web's `notification-choices.ts`, lists them.
struct MuteDuration {
	enum Length {
		case minutes(Int)
		/// Until this hour tomorrow, on this device's clock.
		case tomorrow(atHour: Int)
	}

	let label: String
	let length: Length

	/// When it ends, if started `now`.
	func until(_ now: Date) -> Date {
		switch length {
		case let .minutes(minutes):
			return now.addingTimeInterval(TimeInterval(minutes * 60))
		case let .tomorrow(hour):
			let tomorrow = Calendar.current.date(byAdding: .day, value: 1, to: now) ?? now
			return Calendar.current.date(bySettingHour: hour, minute: 0, second: 0, of: tomorrow) ?? tomorrow
		}
	}

	/// When a pause or mute ends, as `formatUntil`: a time today, or a weekday and time after.
	static func formatUntil(_ until: Date, now: Date = .now, locale: Locale = .current, calendar: Calendar = .current) -> String {
		let style = Date.FormatStyle(locale: locale, calendar: calendar, timeZone: calendar.timeZone)
		let written = calendar.isDate(until, inSameDayAs: now)
			? until.formatted(style.hour().minute())
			: until.formatted(style.weekday(.abbreviated).hour().minute())
		// Apple's dates put a narrow space before AM or PM, where the web's have a plain one.
		return written.replacingOccurrences(of: "\u{202F}", with: " ")
	}
}
