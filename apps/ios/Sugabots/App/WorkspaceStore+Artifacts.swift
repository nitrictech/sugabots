import Foundation

/// The documents and pages a pod's bots have made.
extension WorkspaceStore {
	/// The pod's artifacts, newest first.
	func artifacts(in podId: String) async throws -> [ArtifactSummary] {
		try await client.artifacts.list(podId: podId)
	}

	/// An artifact at `version`, or its current version when nil.
	func artifact(_ artifactId: String, in podId: String, version: Int? = nil) async throws -> Artifact {
		guard let version else { return try await client.artifacts.get(podId: podId, artifactId: artifactId) }
		return try await client.artifacts.getVersion(podId: podId, artifactId: artifactId, version: String(version))
	}

	/// Every version of an artifact, newest first.
	func artifactVersions(_ artifactId: String, in podId: String) async throws -> [ArtifactVersionSummary] {
		try await client.artifacts.versions(podId: podId, artifactId: artifactId)
	}

	/// Deletes an artifact, every version of it.
	func deleteArtifact(_ artifactId: String, in podId: String) async throws {
		try await client.artifacts.remove(podId: podId, artifactId: artifactId)
	}

	/// Where a page's version is served from the installation's content origin, or nil when it has none.
	func pageAddress(_ artifactId: String, in podId: String, version: Int) async throws -> URL? {
		let address = try await client.artifacts.pageAddress(podId: podId, artifactId: artifactId, version: String(version))
		return address.url.flatMap(URL.init(string:))
	}

	/// The web app's address for an artifact, for Copy link.
	func webLink(toArtifact artifactId: String, in pod: Pod) -> URL {
		webURL("pods/\(pod.slug)/artifacts/\(artifactId)")
	}
}
