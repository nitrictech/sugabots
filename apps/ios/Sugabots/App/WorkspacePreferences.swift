import Foundation
import Observation

/// What this device remembers about one workspace between launches: the pod
/// Home shows, and which of a pod's sections are folded. Kept in
/// `UserDefaults` under keys that include the workspace's id, so one
/// workspace's choices don't carry into another; `forget` removes them.
@MainActor
@Observable
final class WorkspacePreferences {
	private enum Key: String, CaseIterable {
		case homePodId
		case foldedSections
	}

	let workspaceId: String

	/// The pod Home shows; nil until one is chosen, when Home shows the first.
	var homePodId: String? {
		didSet { Self.defaults.set(homePodId, forKey: Self.key(.homePodId, workspaceId: workspaceId)) }
	}

	/// The folded sections, each as `<section>:<pod id>`.
	private var foldedSections: Set<String> {
		didSet { Self.defaults.set(foldedSections.sorted(), forKey: Self.key(.foldedSections, workspaceId: workspaceId)) }
	}

	private static var defaults: UserDefaults { .standard }

	init(workspaceId: String) {
		self.workspaceId = workspaceId
		homePodId = Self.defaults.string(forKey: Self.key(.homePodId, workspaceId: workspaceId))
		foldedSections = Set(Self.defaults.stringArray(forKey: Self.key(.foldedSections, workspaceId: workspaceId)) ?? [])
	}

	/// isFolded reports whether `section` of the pod `podId` is folded shut.
	func isFolded(_ section: String, in podId: String) -> Bool {
		foldedSections.contains("\(section):\(podId)")
	}

	/// Folds `section` of the pod `podId` shut, or opens it if it is folded.
	func toggleFolded(_ section: String, in podId: String) {
		let entry = "\(section):\(podId)"
		if foldedSections.contains(entry) { foldedSections.remove(entry) } else { foldedSections.insert(entry) }
	}

	/// Removes what this device remembers about each of `workspaceIds`.
	static func forget(workspaceIds: [String]) {
		for workspaceId in workspaceIds {
			for key in Key.allCases {
				defaults.removeObject(forKey: Self.key(key, workspaceId: workspaceId))
			}
		}
	}

	private static func key(_ key: Key, workspaceId: String) -> String {
		"workspace.\(workspaceId).\(key.rawValue)"
	}
}
