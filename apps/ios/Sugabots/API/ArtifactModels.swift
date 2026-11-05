import Foundation

extension ArtifactVersionSummary: Identifiable {
	var id: Int { number }
}

/// What wrote an artifact in a reply: an `artifact_write` or `artifact_edit` call's output.
struct WrittenArtifact: Hashable, Identifiable {
	let artifactId: String
	let kind: ArtifactKind
	let title: String
	let version: Int

	var id: String { artifactId }

	/// The tools whose calls write artifacts.
	static let writingTools: Set<String> = ["artifact_write", "artifact_edit"]

	/// Each artifact a message shows, once, as the web's `writtenIn`: those a
	/// routine's posted result carries, and those its reply's calls wrote, at
	/// the last version written.
	static func writtenIn(_ parts: [MessagePart]) -> [WrittenArtifact] {
		let carried = parts.compactMap { part -> WrittenArtifact? in
			guard case let .artifact(artifact) = part else { return nil }
			return WrittenArtifact(artifactId: artifact.artifactId, kind: artifact.kind, title: artifact.title, version: artifact.version)
		}
		let calls = parts.compactMap { part -> ToolCallPart? in
			if case let .toolCall(call) = part { call } else { nil }
		}
		var order: [String] = []
		var latest: [String: WrittenArtifact] = [:]
		for artifact in carried + writtenBy(calls) {
			if latest[artifact.artifactId] == nil { order.append(artifact.artifactId) }
			latest[artifact.artifactId] = artifact
		}
		return order.compactMap { latest[$0] }
	}

	/// Each artifact the calls wrote, once, at the last version they wrote.
	static func writtenBy(_ calls: [ToolCallPart]) -> [WrittenArtifact] {
		var order: [String] = []
		var latest: [String: WrittenArtifact] = [:]
		for call in calls where call.status == .completed && writingTools.contains(call.tool) {
			guard case let .object(output)? = call.output,
				case .string("written")? = output["status"],
				case let .string(artifactId)? = output["artifactId"],
				case let .string(kindName)? = output["kind"],
				case let kind = ArtifactKind(rawValue: kindName), ArtifactKind.known.contains(kind),
				case let .string(title)? = output["title"],
				case let .number(version)? = output["version"]
			else { continue }
			if latest[artifactId] == nil { order.append(artifactId) }
			latest[artifactId] = WrittenArtifact(artifactId: artifactId, kind: kind, title: title, version: Int(version))
		}
		return order.compactMap { latest[$0] }
	}
}
