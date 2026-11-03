import Foundation

/// What a tool call is called wherever it is shown, as `lib/tool-names.ts` in the web app names it.
enum ToolNames {
	/// Separates a connection's handle from its tool's name in a tool key: `linear__create_issue`.
	private static let connectionSeparator = "__"
	static let browserPrefix = "browser_"
	static let artifactPrefix = "artifact_"
	static let networkRequestTool = "request_network_access"

	/// What the step does: `Search issues`, or a built-in tool's name.
	static func step(_ tool: String) -> String {
		if let name = builtIn[tool] { return name }
		if tool.hasPrefix(browserPrefix) { return words(fromKey: String(tool.dropFirst(browserPrefix.count))) }
		return words(fromKey: split(tool).name)
	}

	/// The step and the app it is in: `Search issues in Linear`.
	static func title(_ tool: String) -> String {
		let (handle, _) = split(tool)
		guard let handle else { return step(tool) }
		return "\(step(tool)) in \(words(fromKey: handle))"
	}

	/// The connection's handle in a tool's key, or empty for a built-in tool.
	static func handle(_ tool: String) -> String { split(tool).handle ?? "" }

	/// A connection as a step names it: its name, or words from its handle.
	static func connectionLabel(_ handle: String, name: String? = nil) -> String {
		handle.isEmpty ? "Built-in tools" : name ?? words(fromKey: handle)
	}

	private static func split(_ tool: String) -> (handle: String?, name: String) {
		guard let range = tool.range(of: connectionSeparator) else { return (nil, tool) }
		return (String(tool[..<range.lowerBound]), String(tool[range.upperBound...]))
	}

	/// `search_issues` as `Search issues`, `dueDate` as `Due date`.
	static func words(fromKey key: String) -> String {
		var words = ""
		var previous: Character?
		for character in key {
			if character == "_" || character == "-" {
				words.append(" ")
			} else if character.isUppercase, let previous, previous.isLowercase || previous.isNumber {
				words.append(" ")
				words.append(Character(character.lowercased()))
			} else {
				words.append(character)
			}
			previous = character
		}
		let trimmed = words.split(separator: " ").joined(separator: " ")
		guard let first = trimmed.first else { return key }
		return first.uppercased() + trimmed.dropFirst()
	}
}
