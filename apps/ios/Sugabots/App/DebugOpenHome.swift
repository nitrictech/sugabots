import SwiftUI

/// The dialog a development build opens on a page as it appears, named by
/// `SUGABOTS_OPEN`, so it can be screenshotted; always nil in a release build.
struct DebugDialogKey: EnvironmentKey {
	static let defaultValue: String? = nil
}

extension EnvironmentValues {
	var debugDialog: String? {
		get { self[DebugDialogKey.self] }
		set { self[DebugDialogKey.self] = newValue }
	}
}

#if DEBUG
/// Opens a page over Home that `SUGABOTS_OPEN` names, once the workspace loads:
/// routines, a new routine, artifacts, a new bot, a routine's panel, a new
/// trigger or the emoji picker (see `DebugLaunch.Target`).
private struct DebugOpen: ViewModifier {
	@Environment(WorkspaceStore.self) private var store
	@State private var opened: Route?
	@State private var makingBot: Pod?
	@State private var panel: (agent: Agent, pod: Pod, routine: ListedRoutine)?
	@State private var triggerPod: Pod?
	@State private var pickingEmoji = false

	func body(content: Content) -> some View {
		content
			.navigationDestination(item: $opened) { RouteDestination(route: $0) }
			.navigationDestination(isPresented: Binding(get: { panel != nil }, set: { if !$0 { panel = nil } })) {
				if let panel {
					RoutinePanel(
						agent: panel.agent,
						pod: panel.pod,
						conversationId: panel.routine.conversation?.id ?? "",
						standing: ThreadDetails.Routine(
							id: panel.routine.routine.id,
							agentId: panel.agent.id,
							state: panel.routine.routine.state,
							failed: panel.routine.routine.failed,
							pausedAfterFailures: false
						)
					)
					.environment(\.debugDialog, panelDialog)
				}
			}
			.fullScreenCover(item: $makingBot) { pod in NewBotScreen(pod: pod) { _ in makingBot = nil } }
			.fullScreenCover(item: $triggerPod) { pod in
				TriggerSheet(pod: pod, editing: triggerKind == "kinds" ? nil : TriggerDraft.new(triggerKind ?? "cron")) { _ in }
			}
			.sheet(isPresented: $pickingEmoji) {
				EmojiPicker(full: fullEmojiList, used: ["👍"]) { _ in }
			}
			.task(id: store.pods.count) {
				guard opened == nil, makingBot == nil, panel == nil, triggerPod == nil,
					let target = DebugLaunch.target, let pod = DebugLaunch.targetPod(in: store)
				else { return }
				await store.refreshChatList(pod)
				switch target {
				case .routines: opened = .routines(pod, agent: nil)
				case .newRoutine: opened = .newRoutine(pod, agent: nil)
				case .artifacts: opened = .artifacts(pod)
				case .newBot: makingBot = pod
				case .trigger: triggerPod = pod
				case .emoji:
					RecentEmoji.remember("🎉")
					RecentEmoji.remember("👍")
					pickingEmoji = true
				case .routinePanel:
					if let routine = store.chatLists[pod.id]?.routines.first {
						panel = (routine.agent, pod, routine)
					}
				default: break
				}
			}
	}

	private var panelDialog: String? {
		if case let .routinePanel(_, dialog) = DebugLaunch.target { dialog } else { nil }
	}

	private var triggerKind: String? {
		if case let .trigger(_, kind) = DebugLaunch.target { kind } else { nil }
	}

	private var fullEmojiList: Bool {
		if case .emoji(_, full: true) = DebugLaunch.target { true } else { false }
	}
}
#endif

extension View {
	/// In a development build, opens the page `SUGABOTS_OPEN` names; otherwise nothing.
	func debugOpen() -> some View {
		#if DEBUG
		modifier(DebugOpen())
		#else
		self
		#endif
	}
}
