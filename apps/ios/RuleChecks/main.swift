import Foundation

// Runs the web's shared rule cases (`packages/contracts/cases/*.cases.json`)
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
	try APIClient.decoder.decode(T.self, from: JSONEncoder().encode(arguments[index]))
}

/// An object of the fields that have a value; a rule's result leaves out what it doesn't say, as the web's does.
func object(_ fields: [String: JSONValue?]) -> JSONValue {
	.object(fields.compactMapValues { $0 })
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

/// A tool step's words, as `describeStep` gives them.
func stepJSON(_ step: ToolSteps.Step) -> JSONValue {
	object([
		"action": .string(step.action),
		"subject": step.subject.map { object(["text": .string($0.text), "asCode": .bool($0.asCode)]) },
	])
}

/// Whom a mention can name, as the cases give them: participants, and groups as `{ kind: "group", handle }`.
func mentionTargets(_ arguments: [JSONValue], _ index: Int) throws -> [MentionTarget] {
	try argument(arguments, index, as: [JSONValue].self).map { target in
		if target.fields["kind"] == .string("group"), let handle = target.fields["handle"]?.string { return .group(handle: handle) }
		return try .participant(argument([target], 0))
	}
}

/// The index `offset` UTF-16 units into `text`, as JavaScript counts, or its end past that.
func utf16Index(_ offset: Int, in text: String) -> String.Index {
	text.utf16.index(text.startIndex, offsetBy: offset, limitedBy: text.endIndex) ?? text.endIndex
}

/// Connections' looks by handle, as the cases give them.
func looks(_ arguments: [JSONValue], _ index: Int) throws -> [String: ConnectionLook] {
	try argument(arguments, index, as: [String: [String: String]].self).compactMapValues { look in
		look["name"].map { ConnectionLook(name: $0, presetId: look["presetId"]) }
	}
}

/// A date as a local date-time with no offset, `2026-09-25T06:12`, as the cases write one.
func localTimeText(_ date: Date) -> String {
	let formatter = DateFormatter()
	formatter.locale = Locale(identifier: "en_US_POSIX")
	formatter.dateFormat = "yyyy-MM-dd'T'HH:mm"
	return formatter.string(from: date)
}

/// How many image pixels the app draws a point with, as `Gravatar` sizes its pictures.
let pixelsPerPoint: CGFloat = 3

/// Markdown's blocks as an outline, each with its words as they read, as the web's `markdownOutline` draws them.
func outline(_ markdown: String) -> JSONValue {
	func words(_ text: String) -> JSONValue { .string(String(MarkdownBlocks.inline(text).characters)) }
	return .array(MarkdownBlocks.parse(markdown).map { block in
		switch block {
		case let .paragraph(text): object(["type": .string("paragraph"), "text": words(text)])
		case let .heading(level, text): object(["type": .string("heading"), "level": .number(Double(level)), "text": words(text)])
		case let .list(items, ordered, start):
			object([
				"type": .string("list"),
				"ordered": .bool(ordered),
				"start": ordered ? .number(Double(start)) : nil,
				"items": .array(items.map { object(["text": words($0.text), "checked": $0.checked.map(JSONValue.bool), "blocks": outline($0.children)]) }),
			])
		case let .quote(text): object(["type": .string("quote"), "blocks": outline(text)])
		case let .code(language, code): object(["type": .string("code"), "language": language.map(JSONValue.string) ?? .null, "code": .string(code)])
		case let .table(header, rows):
			object(["type": .string("table"), "header": .array(header.map(words)), "rows": .array(rows.map { .array($0.map(words)) })])
		case .rule: object(["type": .string("rule")])
		}
	})
}

/// Each case file, with the Swift rule for each web rule it covers, and the
/// rules it has cases for that this app doesn't copy, with why.
let suites: [(file: String, rules: [String: Rule], notCopied: [String: String])] = [
	("tool-names.cases.json", [
		"stepLabel": { try ToolNames.step(argument($0, 0)) },
		"toolTitle": { try ToolNames.title(argument($0, 0)) },
		"connectionLabel": { try ToolNames.connectionLabel(argument($0, 0), name: $0.count > 1 ? argument($0, 1) : nil) },
		"wordsFromKey": { try ToolNames.words(fromKey: argument($0, 0)) },
	], [:]),
	("tool-steps.cases.json", [
		"toolStepRuns": { arguments in
			try ToolSteps.runs(of: argument(arguments, 0)).map { run in
				object(["narration": run.narration.map(JSONValue.string), "calls": .array(run.calls.map { .string($0.id) })])
			}
		},
		"describeStep": { try stepJSON(ToolSteps.describe(argument($0, 0), fileNames: argument($0, 1))) },
		"stepDetails": { arguments in
			let details = try ToolSteps.details(of: argument(arguments, 0))
			return object(["input": details.input, "otherArguments": details.otherArguments, "output": details.output, "outputCut": details.outputCut.map(JSONValue.string)])
		},
		"outputValue": { try ToolSteps.outputValue(argument($0, 0)) ?? .null },
		"noteOf": { arguments in
			try ToolSteps.note(of: argument(arguments, 0)).map { object(["text": .string($0.text), "failed": .bool($0.failed)]) } ?? .null
		},
		"toolLineText": { try ToolSteps.lineText(argument($0, 0), looks: looks($0, 1)) },
		"durationOf": { try ToolSteps.duration(of: argument($0, 0)) },
		"formatDuration": { try ToolSteps.formatDuration(argument($0, 0)) },
		"formatTotal": { try ToolSteps.formatTotal(argument($0, 0)) },
	], [:]),
	("mentions.cases.json", [
		"splitAroundMentions": { try Mentions.split(argument($0, 0)) },
		"mentionedHandles": { try Mentions.handles(in: argument($0, 0)) },
		"canStartMention": { arguments in
			let text: String = try argument(arguments, 0)
			return try Mentions.canStart(at: utf16Index(argument(arguments, 1), in: text), in: text)
		},
		"firstBotNamed": { try Mentions.firstBot(in: argument($0, 0), among: argument($0, 1))?.id },
		"withGroupMentions": { try Mentions.withGroups(argument($0, 0), threadType: argument($0, 1)).map(\.key) },
		"targetWithHandle": { try Mentions.target(withHandle: argument($0, 1), among: mentionTargets($0, 0))?.key },
	], [:]),
	("message-preview.cases.json", [
		"messagePreview": { try Previews.message(argument($0, 0)) },
		"quotedPreview": { try Previews.quoted(argument($0, 0)) },
	], [:]),
	("thread-layout.cases.json", [
		"segmentsOf": { arguments in
			try Segments.of(argument(arguments, 0)).map { segment -> JSONValue in
				switch segment.kind {
				case let .text(text): object(["type": .string("text"), "key": .string(segment.id), "text": .string(text)])
				case .collaboration: object(["type": .string("collaboration"), "key": .string(segment.id)])
				case .toolCall: object(["type": .string("tool_call"), "key": .string(segment.id)])
				}
			}
		},
		"showsNothingYet": { try Segments.showsNothingYet(argument($0, 0)) },
		"isTyping": { try ChatGroups.isTyping(argument($0, 0)) },
		"startsGroup": { try ChatGroups.startsGroup(argument($0, 0, as: Message?.self), argument($0, 1)) },
		"startsNewDay": { try ChatGroups.startsNewDay($0[0] == .null ? nil : localTime($0, 0), localTime($0, 1)) },
		"formatDay": { try Times.day(localTime($0, 0), now: localTime($0, 1), locale: locale($0, 2)) },
	], [
		"findAnsweringFace": "The app draws no face coming alive for the bot answering yet.",
	]),
	("file-looks.cases.json", [
		"fileLookOf": { arguments in
			let file = try argument(arguments, 0, as: [String: String].self)
			let look = FileLook.of(FilePart(id: "", name: file["name"] ?? "", contentType: file["type"] ?? "", size: 0))
			return "\(look)"
		},
		"extensionOf": { try FileLook.extensionOf(argument($0, 0)) },
		"fileSizeLabel": { try FileLook.sizeLabel(argument($0, 0)) },
	], [:]),
	("time-zones.cases.json", [
		"timeZonePlace": { try TimeZoneChoice.place(of: argument($0, 0)) },
		"utcOffset": { arguments in
			let now = try argument(arguments, 1, as: String.self)
			guard let date = Date(iso8601: now) else { throw CocoaError(.formatting) }
			return try TimeZoneChoice.offset(of: argument(arguments, 0), at: date)
		},
		"timeZoneRegions": { arguments in
			let zones: [String] = try argument(arguments, 0)
			let choices = zones.map { TimeZoneChoice(zone: $0, place: TimeZoneChoice.place(of: $0), offset: "") }
			return TimeZoneRegion.of(choices).map { object(["name": .string($0.name), "zones": .array($0.choices.map { .string($0.zone) })]) }
		},
	], [:]),
	("avatar.cases.json", [
		"initials": { try Initials.of(argument($0, 0)) },
		"gravatarUrl": { try Gravatar.url(for: argument($0, 0), points: CGFloat(argument($0, 1, as: Double.self)) / pixelsPerPoint).absoluteString },
	], [:]),
	("mute.cases.json", [
		"formatUntil": { try MuteDuration.formatUntil(localTime($0, 0), now: localTime($0, 1), locale: locale($0, 2)) },
		"muteUntil": { arguments in
			let label: String = try argument(arguments, 0)
			return try MuteDuration.all.first { $0.label == label }.map { localTimeText($0.until(try localTime(arguments, 1))) }
		},
	], [:]),
	("markdown.cases.json", [
		"markdownOutline": { try outline(argument($0, 0)) },
	], [:]),
	("list-time.cases.json", [
		"formatClockTime": { try Times.clock(localTime($0, 0), locale: locale($0, 1)) },
		"formatListTime": { try Times.list(localTime($0, 0), now: localTime($0, 1), locale: locale($0, 2)) },
		"formatListTimeInSentence": { try Times.listInSentence(localTime($0, 0), now: localTime($0, 1), locale: locale($0, 2)) },
		"formatAge": { try Times.age(localTime($0, 0), now: localTime($0, 1), locale: locale($0, 2)) },
	], [:]),
	("name-list.cases.json", [
		"listNames": { try Names.list(argument($0, 0)) },
		"countOf": { try Names.count(argument($0, 0), argument($0, 1), argument($0, 2)) },
	], [:]),
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
	], [:]),
]

let casesFolder = URL(fileURLWithPath: CommandLine.arguments[1], isDirectory: true)
var failures = 0
var passed = 0

func fail(_ message: String) {
	failures += 1
	print("✗ \(message)")
}

let caseFiles = try FileManager.default.contentsOfDirectory(atPath: casesFolder.path).filter { $0.hasSuffix(".cases.json") }
for file in Set(caseFiles).subtracting(suites.map(\.file)).sorted() {
	fail("\(file) has no Swift rules here")
}

/// A case file's key that starts with this is a note to its readers, not a rule.
let notePrefix = "//"
var notCopied = 0

for (file, rules, uncopied) in suites {
	let entries = try JSONDecoder().decode([String: JSONValue].self, from: Data(contentsOf: casesFolder.appendingPathComponent(file)))
	let cases = try entries.filter { !$0.key.hasPrefix(notePrefix) }.mapValues { try JSONDecoder().decode([RuleCase].self, from: JSONEncoder().encode($0)) }
	for name in Set(cases.keys).symmetricDifference(Set(rules.keys).union(uncopied.keys)).sorted() {
		fail("\(file): \(cases[name] == nil ? "no cases for \(name)" : "no Swift rule for \(name)")")
	}
	for name in Set(rules.keys).intersection(uncopied.keys).sorted() {
		fail("\(file): \(name) is both copied and not")
	}
	notCopied += uncopied.count
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

print("\(passed) passed, \(failures) failed, \(notCopied) rules not copied to this app")
exit(failures == 0 ? 0 : 1)
