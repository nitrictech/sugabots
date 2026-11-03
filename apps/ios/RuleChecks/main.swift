import Foundation

// Runs the web's shared rule cases (`packages/web/src/lib/*.cases.json`)
// against the app's Swift copies of those rules, which the web runs against
// its own in `shared-cases.test.ts`. Built and run by
// `apps/ios/scripts/check-rules.sh`; exits non-zero on any case that differs.

/// One case: the rule's arguments, and what it returns for them.
struct RuleCase: Decodable {
	let given: [JSONValue]
	let expect: JSONValue
}

typealias Rule = ([JSONValue]) throws -> any Encodable

/// A JSON argument as the type a rule takes.
func argument<T: Decodable>(_ arguments: [JSONValue], _ index: Int, as _: T.Type = T.self) throws -> T {
	try JSONDecoder().decode(T.self, from: JSONEncoder().encode(arguments[index]))
}

/// A value as JSON on one line, as a failure quotes it.
func compact(_ value: JSONValue) -> String {
	(try? String(decoding: JSONEncoder().encode(value), as: UTF8.self)) ?? "?"
}

func json(_ value: any Encodable) throws -> JSONValue {
	try JSONDecoder().decode(JSONValue.self, from: JSONEncoder().encode(value))
}

/// A trigger as the routine pages hold it, from the API's input type the cases are written in.
func triggerInput(_ input: RoutineTriggerInput) -> TriggerInput {
	switch input {
	case let .cron(cron): .cron(schedule: TriggerSchedule(cron.schedule), timezone: cron.timezone)
	case .webhook: .webhook(auth: .default, secret: nil)
	case let .github(github): .github(connectionId: github.connectionId, repository: github.repository, events: github.events)
	case let .unknown(kind): fatalError("No trigger kind \(kind) in the API")
	}
}

/// A picked schedule, from the API's schedule the cases are written in.
func calendar(_ schedule: RoutineSchedule) -> CalendarSchedule {
	guard case let .calendar(picked) = TriggerSchedule(schedule) else { fatalError("\(schedule) isn't picked by its parts") }
	return picked
}

/// A local date-time with no offset, `2026-09-25T06:12`, read in this Mac's time zone as the web reads it in its own.
func localTime(_ arguments: [JSONValue], _ index: Int) throws -> Date {
	let formatter = DateFormatter()
	formatter.locale = Locale(identifier: "en_US_POSIX")
	formatter.dateFormat = "yyyy-MM-dd'T'HH:mm"
	let text: String = try argument(arguments, index)
	guard let date = formatter.date(from: text) else { throw CocoaError(.formatting) }
	return date
}

func locale(_ arguments: [JSONValue], _ index: Int) throws -> Locale {
	try Locale(identifier: argument(arguments, index))
}

/// Each case file, with the Swift rule for each web rule it covers.
let suites: [(file: String, rules: [String: Rule])] = [
	("tool-names.cases.json", [
		"stepLabel": { try ToolNames.step(argument($0, 0)) },
		"toolTitle": { try ToolNames.title(argument($0, 0)) },
		"connectionLabel": { try ToolNames.connectionLabel(argument($0, 0), name: $0.count > 1 ? argument($0, 1) : nil) },
		"wordsFromKey": { try ToolNames.words(fromKey: argument($0, 0)) },
	]),
	("list-time.cases.json", [
		"formatClockTime": { try Times.clock(localTime($0, 0), locale: locale($0, 1)) },
		"formatListTime": { try Times.list(localTime($0, 0), now: localTime($0, 1), locale: locale($0, 2)) },
		"formatListTimeInSentence": { try Times.listInSentence(localTime($0, 0), now: localTime($0, 1), locale: locale($0, 2)) },
		"formatAge": { try Times.age(localTime($0, 0), now: localTime($0, 1), locale: locale($0, 2)) },
	]),
	("name-list.cases.json", [
		"listNames": { try Names.list(argument($0, 0)) },
		"countOf": { try Names.count(argument($0, 0), argument($0, 1), argument($0, 2)) },
	]),
	("routine-schedule.cases.json", [
		"formatTime": { try ScheduleWords.formatTime(argument($0, 0)) },
		"formatDayOfMonth": { arguments in
			let day: MonthDay = (try? .day(argument(arguments, 0))) ?? .last
			return ScheduleWords.formatDayOfMonth(day)
		},
		"stepTime": { try ScheduleWords.step(argument($0, 0), by: argument($0, 1)) },
		"nextTime": { try ScheduleWords.nextTime(argument($0, 0)) },
		"formatEvery": { try ScheduleWords.formatEvery(calendar(argument($0, 0))) },
		"scheduleSummary": { try ScheduleWords.summary(calendar(argument($0, 0))) },
		"triggerLabel": { try ScheduleWords.triggerLabel(triggerInput(argument($0, 0))) },
	]),
]

let casesFolder = URL(fileURLWithPath: CommandLine.arguments[1], isDirectory: true)
var failures = 0
var passed = 0

func fail(_ message: String) {
	failures += 1
	print("✗ \(message)")
}

for (file, rules) in suites {
	let cases = try JSONDecoder().decode([String: [RuleCase]].self, from: Data(contentsOf: casesFolder.appendingPathComponent(file)))
	for name in Set(cases.keys).symmetricDifference(rules.keys).sorted() {
		fail("\(file): \(cases[name] == nil ? "no cases for \(name)" : "no Swift rule for \(name)")")
	}
	for (name, entries) in cases.sorted(by: { $0.key < $1.key }) {
		guard let rule = rules[name] else { continue }
		for entry in entries {
			let given = entry.given.map(compact).joined(separator: ", ")
			do {
				let result = try json(rule(entry.given))
				if result == entry.expect {
					passed += 1
				} else {
					fail("\(file): \(name)(\(given)) is \(compact(result)), not \(compact(entry.expect))")
				}
			} catch {
				fail("\(file): \(name)(\(given)) threw \(error)")
			}
		}
	}
}

print("\(passed) passed, \(failures) failed")
exit(failures == 0 ? 0 : 1)
