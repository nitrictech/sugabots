import Foundation

/// How a bot's tool calls read, as the web's `tool-steps.ts`, `tool-activity.ts`
/// and `ToolLine`'s helpers say them.
enum ToolSteps {
	/// A run of calls one after another, with the line of text that introduced it.
	struct Run {
		var narration: String?
		var calls: [ToolCallPart]
	}

	/// What a step did, and to what.
	struct Step {
		let action: String
		var subject: (text: String, asCode: Bool)?
	}

	/// What a step's details show: what it was given, and what it gave back.
	struct Details {
		var input: JSONValue?
		var otherArguments: JSONValue?
		var output: JSONValue?
		var outputCut: String?
	}

	static func runs(of parts: [MessagePart]) -> [Run] {
		var runs: [Run] = []
		for (index, part) in parts.enumerated() {
			guard case let .toolCall(call) = part else { continue }
			let before = index > 0 ? parts[index - 1] : nil
			if case .toolCall = before, !runs.isEmpty {
				runs[runs.count - 1].calls.append(call)
				continue
			}
			var narration: String?
			if case let .text(part) = before {
				let line = Previews.message(part.text).replacingOccurrences(of: #":\s*$"#, with: "", options: .regularExpression)
				narration = line.isEmpty ? nil : line
			}
			runs.append(Run(narration: narration, calls: [call]))
		}
		return runs
	}

	// MARK: The line over a message's steps

	/// `Used Linear and Web for 4s`, `Used Linear, waiting on GitHub approval`.
	static func lineText(_ calls: [ToolCallPart], looks: [String: ConnectionLook]) -> String {
		func apps(_ matching: (ToolCallPart) -> Bool) -> String {
			var seen: [String] = []
			for call in calls where matching(call) {
				let app = appOf(call, look: looks[ToolNames.handle(call.tool)])
				if !seen.contains(app) { seen.append(app) }
			}
			return listed(seen)
		}
		let denied: (ToolCallPart) -> Bool = { call in call.approval?.status == .denied }
		let running = { (call: ToolCallPart) in
			call.status == .running || (call.status == .awaitingApproval && call.approval?.status == .allowed)
		}
		let finished: (ToolCallPart) -> Bool = { call in (call.status == .completed || call.status == .failed) && !denied(call) }
		let used = apps(finished)
		let tail: String? =
			calls.contains(where: \.awaitsApproval) ? "waiting on \(apps(\.awaitsApproval)) approval"
			: calls.contains(where: running) ? "using \(apps(running))"
			: calls.contains(where: denied) ? "\(apps(denied)) denied"
			: nil
		guard let tail else {
			let total = calls.filter(finished).reduce(0) { $0 + duration(of: $1) }
			return "Used \(used) for \(formatTotal(total))"
		}
		return used.isEmpty ? tail.prefix(1).uppercased() + tail.dropFirst() : "Used \(used), \(tail)"
	}

	/// The app a step was taken in: a connection by its name, the browser, artifacts, or the built-in tool.
	static func appOf(_ call: ToolCallPart, look: ConnectionLook?) -> String {
		let handle = ToolNames.handle(call.tool)
		if call.tool.hasPrefix(ToolNames.browserPrefix) { return "Browser" }
		if call.tool.hasPrefix(ToolNames.artifactPrefix) { return "Artifacts" }
		return handle.isEmpty ? ToolNames.words(fromKey: call.tool) : ToolNames.connectionLabel(handle, name: look?.name)
	}

	private static func listed(_ names: [String]) -> String {
		guard names.count > 1, let last = names.last else { return names.first ?? "" }
		return names.dropLast().joined(separator: ", ") + " and " + last
	}

	/// How long a call took, in milliseconds; nothing until it finished.
	static func duration(of call: ToolCallPart) -> Double {
		guard let finishedAt = call.finishedAt else { return 0 }
		return max(finishedAt.timeIntervalSince(call.startedAt) * 1000, 0)
	}

	/// `850ms`, `1.4s`.
	static func formatDuration(_ ms: Double) -> String {
		ms < 1000 ? "\(Int(ms.rounded()))ms" : String(format: "%.1fs", ms / 1000)
	}

	/// `850ms`, `4s`.
	static func formatTotal(_ ms: Double) -> String {
		ms < 1000 ? "\(Int(ms.rounded()))ms" : "\(Int((ms / 1000).rounded()))s"
	}

	// MARK: One step

	static func describe(_ call: ToolCallPart, fileNames: [String: String]) -> Step {
		let input = call.input.fields
		let output = call.output?.fields ?? [:]
		func fileName(_ value: JSONValue?) -> String? { value?.string.flatMap { fileNames[$0] } }
		switch call.tool {
		case "run_command": return step("Ran", code(input["command"]?.string?.firstLine), "Ran a command")
		case "read_file": return step("Read", code(input["path"]?.string), "Read a file")
		case "write_file": return step("Wrote", code(input["path"]?.string), "Wrote a file")
		case "copy_file_to_sandbox": return step("Copied", name(fileName(input["file"])), "Copied a file to the sandbox")
		case "share_file":
			return step("Shared", name(output["shared"]?.string ?? input["name"]?.string ?? input["path"]?.string?.split(separator: "/").last.map(String.init)), "Shared a file")
		case "read_thread_file": return step("Read", name(fileName(input["file"])), "Read a long result")
		case "web_search": return step("Searched the web for", name(input["query"]?.string), "Searched the web")
		case "web_fetch":
			return step("Read", name(output["page"]?.fields["title"]?.string) ?? code(withoutScheme(input["url"]?.string)), "Read a page")
		case "tool_search": return step("Looked for tools to", name(input["query"]?.string), "Looked for tools")
		case "search_history": return step("Searched the thread for", name(input["query"]?.string), "Read back through the thread")
		case "read_docs": return step("Read the docs on", name(input["page"]?.string), "Read the docs")
		case "artifact_list": return Step(action: "Listed artifacts")
		case "artifact_read": return step("Read", name(output["title"]?.string), "Read an artifact")
		case "artifact_write":
			let title = name(output["title"]?.string ?? input["title"]?.string)
			return input["artifactId"] == nil ? step("Created", title, "Created an artifact") : step("Rewrote", title, "Rewrote an artifact")
		case "artifact_edit": return step("Edited", name(output["title"]?.string), "Edited an artifact")
		case "list_routines": return Step(action: "Listed its routines")
		case "create_routine": return step("Set up the routine", name(input["name"]?.string), "Set up a routine")
		case "update_routine": return step("Changed the routine", name(input["name"]?.string), "Changed a routine")
		case "save_instructions": return Step(action: "Saved its instructions")
		case "request_network_access": return step("Asked to reach", code(input["host"]?.string), "Asked to reach a host")
		case "workspace_access": return step("Checked the access of", name(input["person"]?.string), "Checked a person's access")
		default: break
		}
		let action = ToolNames.step(call.tool)
		if call.tool.hasPrefix(ToolNames.browserPrefix) {
			return Step(action: action, subject: code(withoutScheme(input["url"]?.string)))
		}
		let subject = ["query", "title", "name", "url", "path"].compactMap { input[$0]?.string }.first { !$0.trimmingCharacters(in: .whitespaces).isEmpty }
		return Step(action: action, subject: name(subject))
	}

	/// What a step's row says at its end: how it ended, or how many results it found.
	static func note(of call: ToolCallPart) -> (text: String, failed: Bool)? {
		if call.approval?.status == .denied {
			return (call.approval?.decidedByName.map { "Denied by \($0)" } ?? "Denied", true)
		}
		if call.status == .failed { return (call.error ?? "Failed", true) }
		if call.awaitsApproval { return ("Waiting for approval", false) }
		if call.status == .awaitingApproval {
			return (call.approval?.decidedByName.map { "Allowed by \($0)" } ?? "Allowed", false)
		}
		if call.status == .running { return ("Running", false) }
		if let refusal = refusal(in: call.output) { return (refusal, true) }
		guard let count = resultCount(in: outputValue(call.output)) else { return nil }
		return ("\(count) \(count == 1 ? "result" : "results")", false)
	}

	private static func refusal(in output: JSONValue?) -> String? {
		guard case let .object(answer)? = output else { return nil }
		let why = [answer["reason"], answer["error"], answer["message"]].compactMap { $0?.string }.first
		if let refused = answer["refused"]?.string { return refused }
		if answer["ok"] == .bool(false) || answer["status"] == .string("refused") || answer["status"] == .string("failed") {
			return why ?? "Failed"
		}
		if answer["isError"] == .bool(true) { return outputValue(output)?.string ?? "Failed" }
		if case let .number(code)? = answer["exitCode"], code != 0 { return "Exit \(Int(code))" }
		if answer["timedOut"] == .bool(true) { return "Timed out" }
		return nil
	}

	private static func resultCount(in output: JSONValue?) -> Int? {
		switch output {
		case let .array(items)?: return items.count
		case let .object(fields)?:
			for (key, value) in fields.sorted(by: { $0.key < $1.key }) where key != "images" {
				if case let .array(items) = value { return items.count }
			}
			return nil
		default: return nil
		}
	}

	/// What an MCP tool answered, unwrapped from its content parts.
	static func outputValue(_ output: JSONValue?) -> JSONValue? {
		guard case let .object(answer)? = output else { return output }
		if let structured = answer["structuredContent"] { return structured }
		guard case let .array(parts)? = answer["content"] else { return output }
		let texts = parts.compactMap { part -> String? in
			guard case let .object(fields) = part, fields["type"] == .string("text") else { return nil }
			return fields["text"]?.string
		}
		guard texts.count == parts.count else { return output }
		let text = texts.joined(separator: "\n")
		if text.range(of: #"^\s*[\[{]"#, options: .regularExpression) != nil,
			let data = text.data(using: .utf8),
			let parsed = try? JSONDecoder().decode(JSONValue.self, from: data)
		{
			return parsed
		}
		return .string(text)
	}

	static func details(of call: ToolCallPart) -> Details {
		let (stored, cut) = storedOutput(call.output)
		let output = stored?.fields ?? [:]
		func inputWithText(_ key: String) -> Details {
			var rest = call.input.fields
			let text = rest.removeValue(forKey: key)
			return Details(input: text?.string.map { .string($0) }, otherArguments: shown(.object(rest)))
		}
		var details: Details
		switch call.tool {
		case "run_command":
			details = inputWithText("command")
			if stored != nil && stored != .null {
				let printed = [output["stdout"], output["stderr"]].compactMap { $0?.string }.filter { !$0.trimmingCharacters(in: .whitespaces).isEmpty }
				details.output = .string(printed.isEmpty ? "No output" : printed.map { $0.replacingOccurrences(of: #"\s+$"#, with: "", options: .regularExpression) }.joined(separator: "\n"))
			}
		case "read_file":
			details = inputWithText("path")
			details.output = output["content"]?.string.map { .string($0) } ?? shown(stored)
		case "write_file":
			details = inputWithText("content")
			details.output = shown(stored)
		case "read_thread_file":
			details = Details(input: shown(call.input), output: output["lines"]?.string.map { .string($0) } ?? shown(stored))
		default:
			details = Details(input: shown(call.input), output: shown(outputValue(stored)))
		}
		details.outputCut = cut
		return details
	}

	private static func storedOutput(_ output: JSONValue?) -> (JSONValue?, String?) {
		guard case let .object(stored)? = output, stored["truncated"] == .bool(true), let preview = stored["preview"]?.string else {
			return (output, nil)
		}
		var characters = ""
		if case let .number(count)? = stored["characters"] { characters = " of \(Int(count).formatted())" }
		return (.string(preview), "Only the first \(preview.count.formatted())\(characters) characters were kept.")
	}

	private static func shown(_ value: JSONValue?) -> JSONValue? {
		switch value {
		case nil, .null?: return nil
		case let .object(fields)? where fields.isEmpty: return nil
		case let .array(items)? where items.isEmpty: return nil
		default: return value
		}
	}

	private static func step(_ action: String, _ subject: (text: String, asCode: Bool)?, _ otherwise: String) -> Step {
		subject.map { Step(action: action, subject: $0) } ?? Step(action: otherwise)
	}

	private static func code(_ value: String?) -> (text: String, asCode: Bool)? {
		guard let value, !value.trimmingCharacters(in: .whitespaces).isEmpty else { return nil }
		return (value, true)
	}

	private static func name(_ value: String?) -> (text: String, asCode: Bool)? {
		guard let value, !value.trimmingCharacters(in: .whitespaces).isEmpty else { return nil }
		return (value, false)
	}

	private static func withoutScheme(_ value: String?) -> String? {
		value?.replacingOccurrences(of: #"^https?://"#, with: "", options: .regularExpression)
	}
}

extension JSONValue {
	var string: String? {
		if case let .string(value) = self { value } else { nil }
	}

	/// An object's fields, or none for anything else.
	var fields: [String: JSONValue] {
		if case let .object(fields) = self { fields } else { [:] }
	}
}

private extension String {
	var firstLine: String {
		trimmingCharacters(in: .whitespacesAndNewlines).components(separatedBy: "\n").first ?? self
	}
}

extension ToolCallPart {
	/// Whether the call is stopped until a person allows or denies it, as the web's `awaitsApproval`.
	/// An allowed call keeps `awaitingApproval` until its turn starts it, a moment later, but waits on nobody.
	var awaitsApproval: Bool { status == .awaitingApproval && approval?.status == .pending }
}
