import SwiftUI

/// A bot's routines on its Details page, as the web's `Routines` section: the
/// first two, then Show more, each opening its thread, with what starts it and
/// a switch to pause it for those who may.
@MainActor
struct BotRoutinesSection: View {
	let pod: Pod
	let agent: Agent
	@Environment(WorkspaceStore.self) private var store
	@Environment(Toaster.self) private var toaster
	@State private var routines: [Routine] = []
	@State private var open = false
	@State private var changing: String?

	/// How many routines show before Show more.
	private static let shown = 2

	var body: some View {
		Group {
			if !routines.isEmpty {
				DetailsSection(title: "Routines") {
					VStack(alignment: .leading, spacing: 0) {
						ForEach(open ? routines : Array(routines.prefix(Self.shown))) { routine in
							HStack(spacing: 12) {
								NavigationLink(value: Route.routine(pod, routineId: routine.id)) {
									VStack(alignment: .leading, spacing: 1) {
										Text(routine.name).font(Typeface.rubik(15)).foregroundStyle(Palette.foreground).lineLimit(1)
										if let label = ScheduleWords.scheduleLabel(routine) {
											Text(label).font(Typeface.rubik(12)).foregroundStyle(Palette.subtleForeground).lineLimit(1)
										}
									}
									.frame(maxWidth: .infinity, alignment: .leading)
									.contentShape(Rectangle())
								}
								.buttonStyle(.plain)
								WebToggle(label: "\(routine.name) on", isOn: routine.state == .enabled) { on in toggle(routine, on: on) }
									.disabled(!pod.permissions.manageRoutines || changing == routine.id)
							}
							.frame(minHeight: 44)
						}
						if routines.count > Self.shown {
							ShowMoreButton(open: $open).padding(.vertical, 4)
						}
					}
				}
			}
		}
		.task(id: agent.id) { routines = (try? await store.routines(of: agent.id)) ?? [] }
	}

	private func toggle(_ routine: Routine, on: Bool) {
		changing = routine.id
		Task {
			do {
				let changed = try await store.updateRoutine(routine.id, agentId: agent.id, state: on ? .enabled : .paused)
				if let index = routines.firstIndex(where: { $0.id == changed.id }) { routines[index] = changed }
			} catch {
				toaster.show(error.localizedDescription)
			}
			changing = nil
		}
	}
}

/// The pod's connections a bot can use, on its Details page, as the web's
/// `Tools` section: each one's mark, name and how many tools, opening the
/// bot's settings.
@MainActor
struct BotToolsSection: View {
	let pod: Pod
	let agent: Agent
	@Environment(WorkspaceStore.self) private var store
	@Environment(\.openPage) private var openPage
	@State private var connections: [Connection] = []

	var body: some View {
		Group {
			if !connections.isEmpty {
				DetailsSection(title: "Tools") {
					VStack(alignment: .leading, spacing: 0) {
						ForEach(connections) { connection in
							Button { openPage(.settings(.agent(pod, agent))) } label: {
								HStack(spacing: 12) {
									ConnectionMark(presetId: connection.presetId, name: connection.name, size: .md)
									Text(connection.name).font(Typeface.rubik(15)).foregroundStyle(Palette.foreground).lineLimit(1)
									Spacer(minLength: 0)
									Text(Names.count(Self.usable(connection), "tool", "tools"))
										.font(Typeface.rubik(12))
										.foregroundStyle(Palette.subtleForeground)
								}
								.frame(height: 44)
								.contentShape(Rectangle())
							}
							.buttonStyle(PressableRowStyle(cornerRadius: 6))
						}
					}
				}
			}
		}
		.task(id: pod.id) {
			connections = ((try? await store.connections(in: pod.id)) ?? []).filter { Self.usable($0) > 0 }
		}
	}

	/// As `usableToolCount`: the tools a bot may use, with or without asking.
	static func usable(_ connection: Connection) -> Int {
		connection.toolCounts.allow + connection.toolCounts.ask
	}
}

extension WorkspaceStore {
	/// When a routine runs next, as its thread's last divider says it.
	func nextRunWords(routineId: String, agentId: String) async -> String? {
		guard let routine = try? await routines(of: agentId).first(where: { $0.id == routineId }) else { return nil }
		return ScheduleWords.nextRunWords(routine)
	}
}
