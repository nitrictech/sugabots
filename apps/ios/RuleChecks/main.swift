import Foundation

// Runs the web's shared rule cases (`packages/contracts/cases/*.cases.json`)
// against the app's Swift copies of those rules, which the web runs against
// its own in `shared-cases.test.ts`. Built and run by
// `apps/ios/check-rules.sh`; exits non-zero on any case that differs.

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

/// A schedule as the routine pages read it, from the web's `ScheduleReading` the cases are written in.
func reading(_ json: JSONValue) throws -> ScheduleReading {
	switch json.fields["kind"] {
	case .string("picked"): return try .picked(calendar(argument([json.fields["schedule"] ?? .null], 0)))
	case .string("written"):
		return try .written(expression: argument([json.fields["expression"] ?? .null], 0), label: argument([json.fields["label"] ?? .null], 0))
	default: throw CocoaError(.coderReadCorrupt)
	}
}

/// `reading` as the web's `ScheduleReading` writes it.
func readingJSON(_ reading: ScheduleReading) throws -> JSONValue {
	switch reading {
	case let .picked(schedule): return try object(["kind": .string("picked"), "schedule": json(schedule.apiValue)])
	case let .written(expression, label): return object(["kind": .string("written"), "expression": .string(expression), "label": .string(label)])
	case let .unrecognized(kind): return object(["kind": .string("unrecognized"), "repeat": .string(kind)])
	}
}

/// A routine with only `triggers`, as the cases give one, each trigger's
/// `nextScheduledAt` a local date-time read in this Mac's time zone.
func routine(triggers: JSONValue) throws -> Routine {
	let triggers: [JSONValue] = try argument([triggers], 0)
	let atInstants = try triggers.map { trigger -> JSONValue in
		guard case var .object(fields) = trigger, let next = fields["nextScheduledAt"] else { return trigger }
		fields["nextScheduledAt"] = try .string(localTime([next], 0).iso8601)
		return .object(fields)
	}
	let created = JSONValue.string(Date(timeIntervalSince1970: 0).iso8601)
	return try argument([.object([
		"id": .string("routine"), "workspaceId": .string("workspace"), "agentId": .string("agent"), "name": .string(""), "instructions": .string(""),
		"triggers": .array(atInstants), "state": .string("active"), "results": .string("none"), "createdAt": created, "updatedAt": created,
	])], 0)
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

/// A model provider as the settings cases give one: only the fields its rules read.
struct ProviderCase: Decodable {
	let preset: ProviderPresetId?
	let active: Bool?
	let hasApiKey: Bool
	let signedIn: Bool

	var provider: ModelProvider {
		ModelProvider(
			id: "", workspaceId: "", preset: preset, name: "", baseUrl: "", apiFormat: .openai, active: active ?? true, status: .untested,
			hasApiKey: hasApiKey, signedIn: signedIn, customHeaders: [], modelCount: 0, enabledModelCount: 0, lastTestedAt: nil, lastTestError: nil, models: []
		)
	}
}

/// A pod as the settings cases give one: only its kind.
struct PodKindCase: Decodable {
	let kind: Pod.Kind
}

/// Each case file, with the Swift rule for each web rule it covers; the rules
/// it has cases for that this app doesn't copy, with why; and the web's rules
/// this app copies that it has no cases for yet, with why.
let suites: [(file: String, rules: [String: Rule], notCopied: [String: String], withoutCases: [String: String])] = [
	("tool-names.cases.json", [
		"stepLabel": { try ToolNames.step(argument($0, 0)) },
		"toolTitle": { try ToolNames.title(argument($0, 0)) },
		"connectionLabel": { try ToolNames.connectionLabel(argument($0, 0), name: $0.count > 1 ? argument($0, 1) : nil) },
		"wordsFromKey": { try ToolNames.words(fromKey: argument($0, 0)) },
	], [:], [:]),
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
	], [:], [:]),
	("mentions.cases.json", [
		"splitAroundMentions": { try Mentions.split(argument($0, 0)) },
		"mentionedHandles": { try Mentions.handles(in: argument($0, 0)) },
		"canStartMention": { arguments in
			let text: String = try argument(arguments, 0)
			return try Mentions.canStart(at: utf16Index(argument(arguments, 1), in: text), in: text)
		},
		"firstBotNamed": { try Mentions.firstBot(in: argument($0, 0), among: argument($0, 1))?.id },
		"groupMentionsBy": { arguments in
			let writer: Writer = try argument(arguments, 0)
			return try Mentions.groupMentions(
				writtenBy: writer.kind == "person" ? writer.id : nil,
				members: argument(arguments, 1),
				threadType: argument(arguments, 2)
			).map { GroupMentionCase(handle: $0.handle, notifies: $0.notifies.map(\.id)) }
		},
		"targetWithHandle": { try Mentions.target(withHandle: argument($0, 1), among: mentionTargets($0, 0))?.key },
	], [:], [:]),
	("message-preview.cases.json", [
		"messagePreview": { try Previews.message(argument($0, 0)) },
		"quotedPreview": { try Previews.quoted(argument($0, 0)) },
	], [:], [:]),
	("thread-layout.cases.json", [
		"segmentsOf": { arguments in
			try Segments.of(argument(arguments, 0)).map { segment -> JSONValue in
				switch segment.kind {
				case let .text(text): object(["type": .string("text"), "text": .string(text)])
				case .collaboration: object(["type": .string("collaboration")])
				case .toolCall: object(["type": .string("tool_call")])
				}
			}
		},
		"showsNothingYet": { try Segments.showsNothingYet(argument($0, 0)) },
		"isTyping": { try ChatGroups.isTyping(argument($0, 0)) },
		"startsGroup": { try ChatGroups.startsGroup(argument($0, 0, as: Message?.self), argument($0, 1)) },
		"startsNewDay": { try ChatGroups.startsNewDay($0[0] == .null ? nil : localTime($0, 0), localTime($0, 1)) },
		"formatDay": { try Times.day(localTime($0, 0), now: localTime($0, 1), locale: locale($0, 2)) },
		"findAnsweringFace": { arguments in
			guard let face = try ChatGroups.answeringFace(in: argument(arguments, 0), dividers: argument(arguments, 1)) else { return JSONValue.null }
			return object(["messageId": .string(face.messageId), "botTyping": .bool(face.botTyping)])
		},
	], [:], [:]),
	("file-looks.cases.json", [
		"fileLookOf": { arguments in
			let file = try argument(arguments, 0, as: [String: String].self)
			return FileLook.of(FilePart(id: "", name: file["name"] ?? "", contentType: file["type"] ?? "", size: 0)).rawValue
		},
		"extensionOf": { try FileLook.extensionOf(argument($0, 0)) },
		"fileSizeLabel": { try FileLook.sizeLabel(argument($0, 0)) },
	], [:], [:]),
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
	], [:], [:]),
	("avatar.cases.json", [
		"initials": { try Initials.of(argument($0, 0)) },
		"gravatarUrl": { try Gravatar.url(for: argument($0, 0), pixels: argument($0, 1)).absoluteString },
	], [:], [:]),
	("mute.cases.json", [
		"formatUntil": { try MuteDuration.formatUntil(localTime($0, 0), now: localTime($0, 1), locale: locale($0, 2)) },
		"muteUntil": { arguments in
			let label: String = try argument(arguments, 0)
			return try MuteDuration.all.first { $0.label == label }.map { localTimeText($0.until(try localTime(arguments, 1))) }
		},
	], [:], [:]),
	("markdown.cases.json", [
		"markdownOutline": { try outline(argument($0, 0)) },
	], [:], [:]),
	("list-time.cases.json", [
		"formatClockTime": { try Times.clock(localTime($0, 0), locale: locale($0, 1)) },
		"formatListTime": { try Times.list(localTime($0, 0), now: localTime($0, 1), locale: locale($0, 2)) },
		"formatListTimeInSentence": { try Times.listInSentence(localTime($0, 0), now: localTime($0, 1), locale: locale($0, 2)) },
		"formatAge": { try Times.age(localTime($0, 0), now: localTime($0, 1), locale: locale($0, 2)) },
	], [:], [:]),
	("name-list.cases.json", [
		"listNames": { try Names.list(argument($0, 0)) },
		"countOf": { try Names.count(argument($0, 0), argument($0, 1), argument($0, 2)) },
	], [:], [:]),
	("face-motion.cases.json", [
		"sequence": { arguments in
			let paths = try argument(arguments, 1, as: [PathCase].self).map { try $0.path() }
			let timeline = try Timeline.of(paths, from: argument(arguments, 0), velocity: argument(arguments, 2))
			let times: [Double] = try argument(arguments, 3)
			return object([
				"seconds": .number(timeline.seconds),
				"values": .array(times.map { .array(timeline.valuesAt($0).map(JSONValue.number)) }),
			])
		},
		"hopPaths": { arguments in
			try FacePath.hop(size: argument(arguments, 0)).reduce(into: [String: [PathCase]]()) { paths, layer in
				paths[layer.key.rawValue] = layer.value.map(PathCase.init)
			}
		},
	], [:], [:]),
	("slug.cases.json", [
		"slugify": { try slugify(argument($0, 0)) },
	], [:], [:]),
	("settings.cases.json", [
		"providerLacksCredential": { try argument($0, 0, as: ProviderCase.self).provider.lacksCredential },
		"isConnected": { try argument($0, 0, as: ProviderCase.self).provider.connected },
		"heldReason": { try argument($0, 0, as: ModelHolders.self).reason(argument($0, 1)) },
		"parseProviderBaseUrl": { try parseProviderBaseURL(argument($0, 0)) },
		"settingOf": { try ToolKind.setting(of: argument($0, 0), kind: argument($0, 1)).rawValue },
		"shiftMonth": { arguments in
			guard let month = try YearMonth(argument(arguments, 0)) else { throw CocoaError(.formatting) }
			return try month.shifted(by: argument(arguments, 1)).text
		},
		"podSettingsPagesOf": { try PodSettingsPage.pages(for: argument($0, 0, as: PodKindCase.self).kind, computersEnabled: argument($0, 1)).map(\.rawValue) },
	], [:], [:]),
	("routine-schedule.cases.json", [
		"formatTime": { try ScheduleWords.formatTime(argument($0, 0)) },
		"formatDayOfMonth": { arguments in
			let day: MonthDay = try arguments[0] == .string("last") ? .last : .day(argument(arguments, 0))
			return ScheduleWords.formatDayOfMonth(day)
		},
		"stepTime": { try ScheduleWords.step(argument($0, 0), by: argument($0, 1)) },
		"nextTime": { try ScheduleWords.nextTime(argument($0, 0)) },
		"formatEvery": { try ScheduleWords.formatEvery(calendar(argument($0, 0))) },
		"scheduleSummary": { try ScheduleWords.summary(calendar(argument($0, 0))) },
		"triggerLabel": { try ScheduleWords.triggerLabel(triggerInput(argument($0, 0))) },
		"readSchedule": { try readingJSON(ScheduleWords.read(TriggerSchedule(argument($0, 0)), now: localTime($0, 1))) },
		"readingLabel": { try ScheduleWords.readingLabel(reading(argument($0, 0))) },
		"withRepeat": { arguments in
			let repeatKind = try CalendarSchedule.Repeat(rawValue: argument(arguments, 1)) ?? .daily
			return try ScheduleWords.withRepeat(reading(argument(arguments, 0)), repeatKind, now: localTime(arguments, 2)).apiValue
		},
		"defaultSchedule": { try ScheduleWords.defaultSchedule(now: localTime($0, 0)).apiValue },
		"nextRunAt": { try ScheduleWords.nextRunAt(routine(triggers: $0[0].fields["triggers"] ?? .array([])), now: localTime($0, 1)) },
		"scheduleNote": { try ScheduleWords.note(reading(argument($0, 0)), timezone: argument($0, 1)) },
	], [:], [
		"scheduleOfReading": "Covered only through the screens that save a schedule.",
		"scheduleReady": "Covered only through the screens that save a schedule.",
		"scheduleLabel": "Covered through triggerLabel, which it calls for the first trigger.",
		"nextRunWords": "Covered through nextRunAt, which it calls first.",
	]),
]

/// How far a number in a case file's results may be from what the case expects, for files whose numbers are rounded.
let numberTolerances = ["face-motion.cases.json": 0.001]

/// Whether `result` is `expected`, with each number within `tolerance` of the one expected.
func matches(_ result: JSONValue, _ expected: JSONValue, within tolerance: Double) -> Bool {
	switch (result, expected) {
	case let (.number(number), .number(expectedNumber)):
		abs(number - expectedNumber) <= tolerance
	case let (.array(values), .array(expectedValues)):
		values.count == expectedValues.count && zip(values, expectedValues).allSatisfy { matches($0, $1, within: tolerance) }
	case let (.object(fields), .object(expectedFields)):
		Set(fields.keys) == Set(expectedFields.keys) && fields.allSatisfy { key, value in expectedFields[key].map { matches(value, $0, within: tolerance) } ?? false }
	default:
		result == expected
	}
}

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
var copiedWithoutCases: [String] = []

for (file, rules, uncopied, withoutCases) in suites {
	let entries = try JSONDecoder().decode([String: JSONValue].self, from: Data(contentsOf: casesFolder.appendingPathComponent(file)))
	let cases = try entries.filter { !$0.key.hasPrefix(notePrefix) }.mapValues { try JSONDecoder().decode([RuleCase].self, from: JSONEncoder().encode($0)) }
	for name in Set(cases.keys).symmetricDifference(Set(rules.keys).union(uncopied.keys)).sorted() {
		fail("\(file): \(cases[name] == nil ? "no cases for \(name)" : "no Swift rule for \(name)")")
	}
	for name in Set(rules.keys).intersection(uncopied.keys).sorted() {
		fail("\(file): \(name) is both copied and not")
	}
	for name in Set(cases.keys).intersection(withoutCases.keys).sorted() {
		fail("\(file): \(name) has cases now, so isn't one without")
	}
	for name in Set(rules.keys).intersection(withoutCases.keys).sorted() {
		fail("\(file): \(name) is both checked and without cases")
	}
	notCopied += uncopied.count
	copiedWithoutCases += withoutCases.keys.sorted().map { "\(file): \($0) (\(withoutCases[$0] ?? ""))" }
	for (name, entries) in cases.sorted(by: { $0.key < $1.key }) {
		guard let rule = rules[name] else { continue }
		for entry in entries {
			let given = entry.given.map(compact).joined(separator: ", ")
			do {
				let result = try json(rule(entry.given))
				if matches(result, entry.expect, within: numberTolerances[file] ?? 0) {
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

for rule in copiedWithoutCases {
	print("· copied without cases: \(rule)")
}
print("\(passed) passed, \(failures) failed, \(notCopied) rules not copied to this app, \(copiedWithoutCases.count) copied without cases")
exit(failures == 0 ? 0 : 1)

/// Who writes a message in a mentions case: a person, with their id, or a bot or routine.
struct Writer: Decodable {
	let kind: String
	let id: String?
}

/// A face's path as the face motion cases write it, as the web's `Path`: a
/// spring's `to`, `stiffness` and `damping`, or keyframes' `frames`, `times`, `ease` and `seconds`.
struct PathCase: Codable {
	let kind: String
	var to: [Double]?
	var stiffness: Double?
	var damping: Double?
	var frames: [[Double]]?
	var times: [Double]?
	var ease: [String]?
	var seconds: Double?

	init(_ path: FacePath) {
		switch path {
		case let .spring(to, tuning):
			kind = "spring"
			self.to = to
			stiffness = tuning.stiffness
			damping = tuning.damping
		case let .keyframes(keyframes):
			kind = "keyframes"
			frames = keyframes.frames
			times = keyframes.times
			ease = keyframes.ease.map(\.rawValue)
			seconds = keyframes.seconds
		}
	}

	func path() throws -> FacePath {
		if kind == "spring", let to, let stiffness, let damping {
			return .spring(to: to, SpringTuning(stiffness: stiffness, damping: damping))
		}
		if kind == "keyframes", let frames, let times, let seconds, let ease = try ease?.map(Self.easing) {
			return .keyframes(Keyframes(frames: frames, times: times, ease: ease, seconds: seconds))
		}
		throw CocoaError(.coderReadCorrupt)
	}

	private static func easing(_ name: String) throws -> Easing {
		guard let easing = Easing(rawValue: name) else { throw CocoaError(.coderReadCorrupt) }
		return easing
	}
}

/// A group mention as the cases write it: its handle and the ids of whom it notifies.
struct GroupMentionCase: Encodable {
	let handle: String
	let notifies: [String]
}
