import SwiftUI

/// A routine's run in its own thread, as the web's `RunMessage`: the bot's
/// face, name and when it ran, then its report, or how it ended; the latest
/// failed run offers Retry and Fix connection.
@MainActor
struct RunMessage: View {
	let item: ChatMessageItem.Routine
	let agent: AgentParticipant
	let pod: Pod
	let routine: ThreadDetails.Routine
	let latest: Bool
	let mentionable: [ThreadParticipant]
	@Environment(WorkspaceStore.self) private var store
	@Environment(\.openPage) private var openPage
	@Environment(Toaster.self) private var toaster
	@State private var retrying = false

	var body: some View {
		let outcome = RunStatusLabel.Outcome(state: item.state)
		let report = outcome == .passed ? item.report : nil
		HStack(alignment: .top, spacing: 14) {
			BotFace(look: agent.look, size: 36).padding(.top, 2).frame(width: 36)
			VStack(alignment: .leading, spacing: 0) {
				HStack(spacing: 8) {
					Text(agent.name).font(Typeface.rubik(15, .semibold)).foregroundStyle(Palette.foreground)
					BotTag()
					Text(Times.clock(item.createdAt)).font(Typeface.rubik(12)).foregroundStyle(Palette.subtleForeground)
					if report == nil { RunStatusLabel(outcome: outcome) }
				}
				.padding(.bottom, 1)
				if let report {
					MessageMarkdown(text: report, mentionable: mentionable, palette: BotLooks.palette(for: agent.color))
				} else if outcome == .running {
					TypingDots(small: true).foregroundStyle(Palette.mutedForeground).padding(.top, 8)
				} else {
					Text(item.error ?? (outcome == .cancelled ? "The run was stopped." : "It posted nothing."))
						.font(Typeface.rubik(15))
						.lineSpacing(3.5)
						.foregroundStyle(Palette.bodyForeground)
				}
				if latest, outcome == .failed {
					HStack(spacing: 8) {
						Button("Retry", action: retry).buttonStyle(WebButtonStyle(size: .small)).disabled(retrying)
						Button("Fix connection") { openPage(.podSettings(pod)) }.buttonStyle(WebButtonStyle(variant: .secondary, size: .small))
					}
					.padding(.top, 8)
				}
			}
			.frame(maxWidth: .infinity, alignment: .leading)
		}
		.padding(.horizontal, 20)
		.padding(.top, 14)
		.padding(.bottom, 2)
		.accessibilityElement(children: .contain)
		.accessibilityLabel("\(item.routineName): \(outcome.label)")
	}

	private func retry() {
		retrying = true
		Task {
			do {
				try await store.runRoutine(routine.id, agentId: routine.agentId)
			} catch {
				toaster.show(error.localizedDescription)
			}
			retrying = false
		}
	}
}

/// The line after a routine's thread's last run: when it runs next, or Paused.
@MainActor
struct NextRunDivider: View {
	let routine: ThreadDetails.Routine
	@Environment(WorkspaceStore.self) private var store
	@State private var next: String?

	var body: some View {
		Group {
			if routine.state == .paused {
				LabelledDivider(text: "Paused", strong: false)
			} else if let next {
				LabelledDivider(text: next, strong: false)
			}
		}
		.task(id: routine.id) {
			next = await store.nextRunWords(routineId: routine.id, agentId: routine.agentId)
		}
	}
}
