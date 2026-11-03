import SwiftUI

#if DEBUG
/// Opens a settings page that `SUGABOTS_OPEN` names over the tabs, in its own
/// stack, with You's tab behind it (see `DebugLaunch.Target`).
@MainActor
private struct DebugOpen: ViewModifier {
	@Binding var tab: MainTabs.Tab
	@Environment(WorkspaceStore.self) private var store
	@State private var opened: SettingsPlace?
	@State private var done = false

	func body(content: Content) -> some View {
		content
			.fullScreenCover(item: Binding(get: { opened.map(Opened.init) }, set: { opened = $0?.place })) { item in
				NavigationStack {
					SettingsDestination(place: item.place)
						.navigationDestination(for: Route.self) { RouteDestination(route: $0) }
				}
			}
			.task(id: store.pods.count) { open() }
	}

	private struct Opened: Identifiable {
		let place: SettingsPlace
		var id: String { "\(place)" }
	}

	private func open() {
		guard !done, let target = DebugLaunch.target else { return }
		let pod = DebugLaunch.targetPod(in: store)
		switch target {
		case .profile: opened = .profile
		case .notifications: opened = .notifications
		case let .workspace(section): opened = .workspace(section)
		case .youPod: opened = pod.map(SettingsPlace.pod)
		case let .podPage(_, page): opened = pod.map { .podPage($0, page) }
		case let .agentSettings(_, name):
			if let pod, let agent = DebugLaunch.bot(named: name, in: pod, store: store) { opened = .agent(pod, agent) }
		case .member:
			done = true
			Task {
				guard let first = try? await store.workspaceMembers().first else { return }
				opened = .member(id: first.id)
				tab = .you
			}
			return
		default: return
		}
		if opened != nil {
			tab = .you
			done = true
		}
	}
}

extension View {
	func debugOpen(tab: Binding<MainTabs.Tab>) -> some View {
		modifier(DebugOpen(tab: tab))
	}
}
#endif

/// Whether `SUGABOTS_SHEET` names `sheet`, so a page opens that sheet of its
/// own for a screenshot the first time it appears. Always false outside
/// development builds.
@MainActor
enum DebugSheet {
	/// Whether the sheet was opened this launch, so it opens once, not each time its page appears.
	private static var opened = false

	static func wants(_ sheet: String) -> Bool {
		#if DEBUG
		guard !opened, DebugLaunch.sheet == sheet else { return false }
		opened = true
		return true
		#else
		false
		#endif
	}
}
