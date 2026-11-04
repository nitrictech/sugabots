import Foundation

// How the routine pages edit what starts a routine, and how those edits become
// the API's `RoutineSchedule`, `WebhookAuth` and `RoutineTriggerInput`.

/// Which day of the month a monthly schedule runs on: the 1st to the 28th, or the last.
enum MonthDay: Hashable {
	case day(Int)
	case last
}

/// A schedule picked by its parts: every so many days, weeks or months, from
/// `startsOn`, at `times`; on `days` of a week, or on `dayOfMonth` of a month.
struct CalendarSchedule: Hashable {
	enum Repeat: String, CaseIterable, Hashable {
		case daily, weekly, monthly
	}

	var repeatKind: Repeat
	var every: Int
	/// Minutes past midnight.
	var times: [Int]
	/// `YYYY-MM-DD`, which the count of days, weeks or months starts from.
	var startsOn: String
	/// A weekly schedule's days.
	var days: [Weekday] = []
	/// A monthly schedule's day.
	var dayOfMonth: MonthDay = .day(1)

	var apiValue: RoutineSchedule {
		switch repeatKind {
		case .daily:
			.daily(.init(every: every, times: times, startsOn: startsOn))
		case .weekly:
			.weekly(.init(every: every, days: days, times: times, startsOn: startsOn))
		case .monthly:
			.monthly(.init(every: every, dayOfMonth: dayOfMonth.apiValue, times: times, startsOn: startsOn))
		}
	}
}

extension MonthDay {
	var apiValue: RoutineSchedule.Monthly.DayOfMonth {
		switch self {
		case let .day(number): .integer(number)
		case .last: .last
		}
	}
}

/// When a scheduled routine runs: picked by its parts, or a cron expression
/// kept as written before schedules were picked this way.
enum TriggerSchedule: Hashable {
	case calendar(CalendarSchedule)
	case cron(String)

	init(_ schedule: RoutineSchedule) {
		switch schedule {
		case let .daily(daily):
			self = .calendar(CalendarSchedule(repeatKind: .daily, every: daily.every, times: daily.times, startsOn: daily.startsOn))
		case let .weekly(weekly):
			self = .calendar(CalendarSchedule(repeatKind: .weekly, every: weekly.every, times: weekly.times, startsOn: weekly.startsOn, days: weekly.days))
		case let .monthly(monthly):
			let day: MonthDay =
				switch monthly.dayOfMonth {
				case let .integer(number): .day(number)
				case .last: .last
				}
			self = .calendar(CalendarSchedule(repeatKind: .monthly, every: monthly.every, times: monthly.times, startsOn: monthly.startsOn, dayOfMonth: day))
		case let .cron(cron):
			self = .cron(cron.expression)
		case .unknown:
			self = .cron("")
		}
	}

	var apiValue: RoutineSchedule {
		switch self {
		case let .calendar(schedule): schedule.apiValue
		case let .cron(expression): .cron(.init(expression: expression))
		}
	}
}

/// How a webhook's caller proves it holds the routine's secret, as its editor
/// picks it: as a known source signs, or one of the generic kinds.
enum WebhookAuthChoice: Hashable {
	/// `github`, `stripe`, `slack` or `linear`, each signing its own way.
	case source(String)
	case hmac(header: String, algorithm: String, encoding: String)
	case apiKey(header: String)
	case bearer
	case basic(username: String)

	/// The senders that sign their own way, as the API knows them.
	static let sources = WebhookAuth.GithubOrStripeOrSlackOrLinear.Kind.known.map(\.rawValue)

	/// What a webhook starts with until somebody chooses: a signature, which most senders make.
	static let `default` = WebhookAuthChoice.hmac(header: "X-Signature", algorithm: "sha256", encoding: "hex")

	init(_ auth: WebhookAuth) {
		switch auth {
		case let .githubOrStripeOrSlackOrLinear(source): self = .source(source.kind.rawValue)
		case let .hmac(hmac): self = .hmac(header: hmac.header, algorithm: hmac.algorithm.rawValue, encoding: hmac.encoding.rawValue)
		case let .apiKey(apiKey): self = .apiKey(header: apiKey.header)
		case .bearer: self = .bearer
		case let .basic(basic): self = .basic(username: basic.username)
		case .unknown: self = .default
		}
	}

	var kind: String {
		switch self {
		case let .source(source): source
		case .hmac: "hmac"
		case .apiKey: "api_key"
		case .bearer: "bearer"
		case .basic: "basic"
		}
	}

	var isSource: Bool {
		if case .source = self { return true }
		return false
	}

	var apiValue: WebhookAuth {
		switch self {
		case let .source(source): .githubOrStripeOrSlackOrLinear(.init(kind: .init(rawValue: source)))
		case let .hmac(header, algorithm, encoding):
			.hmac(.init(header: header, algorithm: .init(rawValue: algorithm), encoding: .init(rawValue: encoding)))
		case let .apiKey(header): .apiKey(.init(header: header))
		case .bearer: .bearer(.init())
		case let .basic(username): .basic(.init(username: username))
		}
	}
}

/// A trigger as it is written to make or change it.
enum TriggerInput: Hashable {
	case cron(schedule: TriggerSchedule, timezone: String)
	/// `secret` nil for none, so the address alone runs it.
	case webhook(auth: WebhookAuthChoice, secret: String?)
	case github(connectionId: String, repository: String, events: [RepositoryEvent])

	var kind: String {
		switch self {
		case .cron: "cron"
		case .webhook: "webhook"
		case .github: "github"
		}
	}

	var apiValue: RoutineTriggerInput {
		switch self {
		case let .cron(schedule, timezone):
			.cron(.init(schedule: schedule.apiValue, timezone: timezone))
		case let .webhook(auth, secret):
			.webhook(.init(auth: auth.apiValue, secret: .some(secret)))
		case let .github(connectionId, repository, events):
			.github(.init(connectionId: connectionId, repository: repository, events: events))
		}
	}
}

extension RoutineTrigger: Identifiable {
	var id: String {
		switch self {
		case let .cron(cron): cron.id
		case let .webhook(webhook): webhook.id
		case let .github(github): github.id
		case let .unknown(kind): "unknown:\(kind)"
		}
	}

	var kind: String {
		switch self {
		case .cron: "cron"
		case .webhook: "webhook"
		case .github: "github"
		case let .unknown(kind): kind
		}
	}

	/// When it next runs on its schedule; nil while paused, or off a schedule.
	var nextScheduledAt: Date? {
		if case let .cron(cron) = self { cron.nextScheduledAt } else { nil }
	}

	/// The trigger as written to save it again.
	var input: TriggerInput {
		switch self {
		case let .cron(cron): .cron(schedule: TriggerSchedule(cron.schedule), timezone: cron.timezone)
		case let .github(github): .github(connectionId: github.connectionId, repository: github.repository, events: github.events)
		case let .webhook(webhook): .webhook(auth: WebhookAuthChoice(webhook.auth), secret: nil)
		case .unknown: .webhook(auth: .default, secret: nil)
		}
	}
}

extension Routine {
	/// A copy on the same bot, paused so the two don't both run, as the web's
	/// `copyOf`: a webhook copy gets its own address and a new secret, and a
	/// repository copy runs on the same repository and events.
	func copy(siblingNames: [String]) -> NewRoutine {
		NewRoutine(
			name: Self.copyName(name, taken: siblingNames),
			instructions: instructions,
			state: .paused,
			results: results,
			triggers: triggers.map { trigger in
				if case let .webhook(auth, _) = trigger.input { return .webhook(.init(auth: auth.apiValue)) }
				return trigger.input.apiValue
			}
		)
	}

	/// "{name} copy", or "{name} copy 2" and on when that is taken, shortened to fit.
	static func copyName(_ name: String, taken: [String]) -> String {
		var number = 1
		while true {
			let suffix = number == 1 ? " copy" : " copy \(number)"
			let candidate = String(name.prefix(Limits.maxRoutineNameCharacters - suffix.count)) + suffix
			if !taken.contains(candidate) { return candidate }
			number += 1
		}
	}
}
