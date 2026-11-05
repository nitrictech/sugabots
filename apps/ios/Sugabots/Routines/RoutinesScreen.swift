import SwiftUI

/// A pod's routines, or one bot's, as the web's `RoutinesPage` on a phone:
/// Back to the pod, the title, and New routine for someone who may make one,
/// then each routine with how it stands. Each opens its own thread.
@MainActor
struct RoutinesScreen: View {
	let pod: Pod
	var agent: Agent?
	@Environment(WorkspaceStore.self) private var store
	@State private var fullRoutines: [String: Routine] = [:]
	/// Why the routines' schedules or last runs couldn't be read, so a row's "Not run yet" isn't taken at its word.
	@State private var failure: String?

	var body: some View {
		let list = store.chatLists[pod.id]
		let routines = (list?.routines ?? []).filter { agent == nil || $0.agent.id == agent?.id }
		VStack(spacing: 0) {
			PodPageHeader(title: agent.map { "\($0.name)'s routines" } ?? "Routines") {
				if pod.permissions.manageRoutines {
					NavigationLink(value: Route.newRoutine(pod, agent: agent)) {
						GlassRoundIcon(icon: .plus, strokeWidth: 1.75)
					}
					.buttonStyle(.plain)
					.accessibilityLabel("New routine")
				}
			}
			if list != nil, routines.isEmpty {
				EmptyState(
					title: agent.map { "No routines for \($0.name) yet" } ?? "No routines in \(pod.name) yet",
					icon: .refreshCcw,
					text: "Ask \(agent?.name ?? "a bot") to set some up for you."
				)
				.padding(.bottom, 60)
			} else {
				ScrollView {
					if let failure { FormAlert(text: failure).padding(.horizontal, 16).padding(.top, 8) }
					LazyVStack(spacing: 2) {
						ForEach(routines) { row in
							RoutineRow(pod: pod, row: row, routine: fullRoutines[row.routine.id]) { failure = $0.localizedDescription }
						}
					}
					.padding(8)
				}
			}
		}
		.background(Palette.background.ignoresSafeArea())
		.task {
			await store.refreshChatList(pod)
			// The API lists routines in full only for a whole workspace or a single bot, so
			// one request for the workspace's beats one for each of the pod's bots.
			do {
				let all = try await store.workspaceRoutines()
				fullRoutines = Dictionary(all.map { ($0.routine.id, $0.routine) }, uniquingKeysWith: { first, _ in first })
			} catch {
				failure = error.localizedDescription
			}
		}
	}
}

/// A routine: its bot, its name, when it last ran, and under it how it
/// stands: paused, or how its last run went, or when it runs before it has.
/// A paused one is greyer; one whose thread mentions the person is bright.
@MainActor
private struct RoutineRow: View {
	let pod: Pod
	let row: ListedRoutine
	/// The routine in full, for when it runs, once the workspace's routines are loaded.
	let routine: Routine?
	let onFailure: (Error) -> Void
	@Environment(WorkspaceStore.self) private var store
	@State private var lastRun: RoutineExecution?

	var body: some View {
		let paused = row.routine.state == .paused
		NavigationLink(value: Route.routine(pod, routineId: row.routine.id)) {
			HStack(alignment: .top, spacing: 10) {
				BotFace(look: row.agent.look, size: 20).opacity(paused ? 0.5 : 1)
				VStack(alignment: .leading, spacing: 2) {
					HStack(alignment: .firstTextBaseline, spacing: 8) {
						Text(row.routine.name)
							.font(Typeface.rubik(13, row.mentionsYou ? .semibold : .regular))
							.foregroundStyle(row.mentionsYou ? Palette.foreground : paused ? Palette.subtleForeground : Palette.mutedForeground)
							.lineLimit(1)
							.frame(maxWidth: .infinity, alignment: .leading)
						if let lastRun {
							Text(Times.age(lastRun.acceptedAt)).font(Typeface.rubik(12)).foregroundStyle(Palette.subtleForeground)
						}
					}
					if paused {
						RunStatusLabel(outcome: .paused)
					} else if let lastRun {
						RunStatusLabel(outcome: .init(state: lastRun.state))
					} else {
						Text(routine.flatMap(ScheduleWords.scheduleLabel) ?? "Not run yet")
							.font(Typeface.rubik(12))
							.foregroundStyle(Palette.subtleForeground)
							.lineLimit(1)
					}
				}
			}
			.padding(10)
			.contentShape(Rectangle())
		}
		.buttonStyle(PressableRowStyle(cornerRadius: 8))
		.accessibilityLabel(row.mentionsYou ? "\(row.routine.name), mentions you" : row.routine.name)
		.task(id: row.routine.id) {
			// No list of routines carries each one's last run, so each row asks for its own.
			do {
				lastRun = try await store.latestRun(of: row.routine.id, agentId: row.agent.id)
			} catch {
				// A row scrolled out of the list cancels its request, which isn't a failure.
				if !Task.isCancelled { onFailure(error) }
			}
		}
	}
}

/// The header of a page in a pod on a phone, as the web's `PageHeader`:
/// Back to the pod, the title centred, and room for one action at the right.
struct PodPageHeader<Actions: View>: View {
	let title: String
	@ViewBuilder var actions: Actions

	var body: some View {
		HStack(spacing: 8) {
			PhoneBackButton()
			Text(title)
				.font(Typeface.rubik(17, .semibold))
				.foregroundStyle(Palette.foreground)
				.lineLimit(1)
				.frame(maxWidth: .infinity)
				.accessibilityAddTraits(.isHeader)
			if Actions.self == EmptyView.self {
				// With no action, room as wide as one, so the title stays centred.
				Color.clear.frame(width: 44, height: 44)
			} else {
				actions
			}
		}
		.pageHeaderInsets()
	}
}

extension PodPageHeader where Actions == EmptyView {
	init(title: String) {
		self.init(title: title) { EmptyView() }
	}
}
