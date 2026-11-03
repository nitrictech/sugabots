import SwiftUI

/// A routine being made in `pod`, for `agent` when it was begun from that
/// bot's routines, as the web's `NewRoutine` and `NewRoutinePage`. Nothing is
/// saved until Create, which opens the new routine's own thread in this
/// page's place.
@MainActor
struct NewRoutineScreen: View {
	let pod: Pod
	let agent: Agent?
	@Environment(WorkspaceStore.self) private var store
	@Environment(\.dismiss) private var dismiss
	@State private var name = ""
	@State private var instructions = ""
	@State private var agentId: String?
	@State private var triggers: [(key: String, draft: TriggerDraft)] = []
	/// The sheet open on a trigger, by its key, or on adding one.
	@State private var openTrigger: TriggerKey?
	/// Nil until chosen, so the result follows the first trigger's default.
	@State private var chosenResults: RoutineResults?
	/// Nil for the pod's first chat.
	@State private var chatId: String?
	@State private var writingInstructions = false
	@State private var creating = false
	@State private var failure: String?
	@State private var created: Routine?

	var body: some View {
		let crew = store.bots(in: pod)
		if !pod.permissions.manageRoutines || crew.isEmpty {
			VStack(spacing: 0) {
				PodPageHeader(title: "New routine")
				EmptyState(
					title: "No routine can be made here",
					text: pod.permissions.manageRoutines
						? "\(pod.name) has no bots to run one yet."
						: "Only people who manage \(pod.name)'s routines can make one."
				)
			}
			.background(Palette.background.ignoresSafeArea())
		} else if let created {
			OpeningConversationScreen.routineFeed(created.id, in: pod)
		} else {
			form(crew: crew)
		}
	}

	private func form(crew: [Agent]) -> some View {
		let bot = crew.first { $0.id == (agentId ?? agent?.id) } ?? crew.first
		// Begun from one bot's routines, it can only be that bot's.
		let botFixed = agent.map { fixed in crew.contains { $0.id == fixed.id } } ?? false
		let inputs = triggers.compactMap { try? $0.draft.written.get() }
		let results = chosenResults ?? (inputs.first.map { $0.kind == "cron" ? .postToChat : .keepInRun } ?? .postToChat)
		let ready = bot != nil && !name.trimmingCharacters(in: .whitespaces).isEmpty && !instructions.trimmingCharacters(in: .whitespaces).isEmpty
		let title = name.trimmingCharacters(in: .whitespaces).isEmpty ? "New routine" : name.trimmingCharacters(in: .whitespaces)
		return SettingsPage(
			title: title,
			description: botFixed && bot != nil
				? "Something \(bot?.name ?? "") does without being asked. Set it up, then create it."
				: "Set it up, then create it."
		) {
			SettingsGroup {
				SettingsFieldRow(label: "Name", value: $name, placeholder: "e.g. Friday pipeline review", maxLength: Routine.maxNameCharacters)
				SettingsDivider()
				if botFixed, let bot {
					SettingsRow(label: "Bot", trailing: { SettingsValue(text: bot.name) })
				} else {
					BotChoiceRow(chosen: bot, pod: pod, choices: crew) { chosen in
						agentId = chosen
						// Another bot's pod may not have the repositories its triggers watch.
						triggers.removeAll { $0.draft.kind == "github" }
					}
				}
				SettingsDivider()
				Button { writingInstructions = true } label: {
					SettingsRow(label: "Instructions", chevron: true, trailing: {
						SettingsValue(text: instructions.trimmingCharacters(in: .whitespaces).isEmpty ? "Add" : "Edit")
					})
				}
				.buttonStyle(SettingsRowPressStyle())
			}
			TriggersGroup(
				triggers: triggers.compactMap { item in (try? item.draft.written.get()).map { (item.key, $0) } },
				editable: true,
				open: { openTrigger = TriggerKey(key: $0) },
				add: { openTrigger = TriggerKey(key: nil) }
			)
			SettingsGroup {
				SwitchRow(label: "Also post result in the pod's channel", isOn: Binding(
					get: { results == .postToChat },
					set: { chosenResults = $0 ? .postToChat : .keepInRun }
				), fontSize: 13)
				if results == .postToChat {
					RoutineChatRow(pod: pod, chatId: $chatId)
				}
			}
			if let failure { FormAlert(text: failure) }
			HStack(spacing: 8) {
				Spacer()
				Button("Cancel") { dismiss() }
					.buttonStyle(WebButtonStyle(variant: .secondary))
					.disabled(creating)
				Button("Create routine") { create(bot: bot, results: results, inputs: inputs) }
					.buttonStyle(WebButtonStyle())
					.disabled(!ready || creating)
			}
		}
		.navigationDestination(isPresented: $writingInstructions) {
			RoutineInstructionsPage(botName: bot?.name, value: $instructions)
		}
		.fullScreenCover(item: $openTrigger) { open in
			let editing = triggers.first { $0.key == open.key }
			TriggerSheet(
				pod: pod,
				editing: editing?.draft,
				save: { input in
					let draft = TriggerDraft.of(input)
					if let editing, let index = triggers.firstIndex(where: { $0.key == editing.key }) {
						triggers[index].draft = draft
					} else {
						triggers.append((UUID().uuidString, draft))
					}
				},
				remove: editing.map { editing in { triggers.removeAll { $0.key == editing.key } } }
			)
		}
	}

	private func create(bot: Agent?, results: RoutineResults, inputs: [TriggerInput]) {
		guard let bot else { return }
		creating = true
		failure = nil
		Task {
			do {
				let result = try await store.createRoutine(
					agentId: bot.id,
					routine: NewRoutine(
						name: name.trimmingCharacters(in: .whitespaces),
						instructions: instructions.trimmingCharacters(in: .whitespaces),
						results: results,
						chatId: results == .postToChat ? chatId : nil,
						triggers: inputs.map(\.apiValue)
					)
				)
				created = result.routine
			} catch {
				failure = error.localizedDescription
			}
			creating = false
		}
	}

	/// Which trigger's sheet is open: one by its key, or nil while adding one.
	struct TriggerKey: Identifiable {
		let key: String?
		var id: String { key ?? "adding" }
	}
}

/// The routine's bot. With more than one to choose, it opens in place to the
/// pod's bots; with one, it only shows it.
private struct BotChoiceRow: View {
	let chosen: Agent?
	let pod: Pod
	let choices: [Agent]
	let choose: (String) -> Void
	@State private var open = false

	var body: some View {
		VStack(alignment: .leading, spacing: 0) {
			Button { open.toggle() } label: {
				HStack(spacing: 12) {
					Text("Bot").font(Typeface.rubik(16)).foregroundStyle(Palette.foreground).frame(minWidth: 96, alignment: .leading)
					summary
					if choices.count > 1 {
						Icon(.chevronRight, size: 15, strokeWidth: 2.4)
							.foregroundStyle(Palette.subtleForeground)
							.rotationEffect(.degrees(open ? 90 : 0))
							.animation(.easeOut(duration: 0.15), value: open)
					}
				}
				.padding(.horizontal, 16)
				.padding(.vertical, 10)
				.frame(minHeight: 56)
				.contentShape(Rectangle())
			}
			.buttonStyle(SettingsRowPressStyle())
			.disabled(choices.count < 2)
			.accessibilityValue(open ? "Expanded" : "Collapsed")
			if open {
				Text(pod.name)
					.font(Typeface.rubik(12.5, .medium))
					.foregroundStyle(Palette.subtleForeground)
					.padding(.horizontal, 4)
					.padding(.bottom, 4)
					.padding(.leading, 116)
				ForEach(choices) { agent in
					Button {
						choose(agent.id)
						open = false
					} label: {
						HStack(spacing: 10) {
							BotFace(look: agent.look, size: 24)
							Text(agent.name).font(Typeface.rubik(13)).foregroundStyle(Palette.foreground).frame(maxWidth: .infinity, alignment: .leading)
							if agent.id == chosen?.id { Icon(.check, size: 16, strokeWidth: 2.4).foregroundStyle(Palette.foreground) }
						}
						.padding(.horizontal, 4)
						.padding(.vertical, 6)
						.contentShape(Rectangle())
					}
					.buttonStyle(PressableRowStyle(pressed: Palette.rowHover, cornerRadius: 12))
					.accessibilityAddTraits(agent.id == chosen?.id ? .isSelected : [])
					.padding(.leading, 116)
					.padding(.trailing, 8)
				}
				Color.clear.frame(height: 6)
			}
		}
	}

	private var summary: some View {
		HStack(spacing: 10) {
			if let chosen {
				BotFace(look: chosen.look, size: 24)
				Text(chosen.name).font(Typeface.rubik(13)).foregroundStyle(Palette.foreground).lineLimit(1)
				Text(pod.name).font(Typeface.rubik(12.5)).foregroundStyle(Palette.mutedForeground).lineLimit(1)
			} else {
				Text("Choose a bot").font(Typeface.rubik(13)).foregroundStyle(Palette.mutedForeground)
			}
		}
		.frame(maxWidth: .infinity, alignment: .leading)
	}
}

/// Which of the pod's chats a routine's results go to, offered once the pod
/// has more than one: its first, which a nil `chatId` stands for, or another.
struct RoutineChatRow: View {
	let pod: Pod
	@Binding var chatId: String?
	@Environment(WorkspaceStore.self) private var store

	var body: some View {
		let chats = pod.kind == .shared ? store.chatLists[pod.id]?.chats ?? [] : []
		if chats.count >= 2 {
			let chosen = chats.first { $0.conversation.id == chatId } ?? chats.first { $0.conversation.main }
			SettingsDivider()
			SettingsControlRow(label: "Chat") {
				Spacer(minLength: 0)
				Menu {
					ForEach(chats) { chat in
						Button {
							chatId = chat.conversation.main ? nil : chat.conversation.id
						} label: {
							if chat.id == chosen?.id { Label(chat.conversation.title, systemImage: "checkmark") } else { Text(chat.conversation.title) }
						}
					}
				} label: {
					HStack(spacing: 6) {
						Text(chosen?.conversation.title ?? "").lineLimit(1)
						Icon(.chevronDown, size: 14).foregroundStyle(Palette.mutedForeground)
					}
					.font(Typeface.rubik(14))
					.foregroundStyle(Palette.foreground)
					.padding(.horizontal, 10)
					.frame(height: 32)
					.background(Palette.chip, in: RoundedRectangle(cornerRadius: 8, style: .continuous))
				}
				.accessibilityLabel("Chat: \(chosen?.conversation.title ?? "")")
			}
		}
	}
}

/// A routine's instructions as they are written, in a group under which a
/// note says what to write and how much room is left, as the web's textarea
/// for them. It is taller on a page of its own than in a dialog.
struct RoutineInstructionsField: View {
	@Binding var text: String
	var editable = true
	let minHeight: CGFloat
	/// The room around the text.
	let inset: CGFloat

	var body: some View {
		SettingsGroup(note: editable ? Self.note(text) : nil) {
			TextField(
				"",
				text: $text.limited(to: Routine.maxInstructionsCharacters),
				prompt: Text("e.g. Summarise this week's replies and flag anything that has stalled.").foregroundStyle(Palette.subtleForeground),
				axis: .vertical
			)
			.font(Typeface.rubik(16))
			.lineSpacing(6)
			.foregroundStyle(Palette.foreground)
			.disabled(!editable)
			.frame(minHeight: minHeight, alignment: .topLeading)
			.padding(inset)
			.padding(4)
			.accessibilityLabel("Instructions")
		}
	}

	/// What to say, and how much room is left.
	private static func note(_ instructions: String) -> String {
		let count = { (number: Int) in number.formatted(.number.locale(Locale(identifier: "en"))) }
		return "Say what to look at, what to do, and what a good result looks like. \(count(instructions.count)) of \(count(Routine.maxInstructionsCharacters)) characters."
	}
}

/// What a routine tells its bot each time it runs, on a page of its own with room to write.
struct RoutineInstructionsPage: View {
	let botName: String?
	@Binding var value: String
	var editable = true
	@Environment(\.dismiss) private var dismiss

	var body: some View {
		SettingsPage(title: "Instructions", description: "What \(botName ?? "the bot") does each time this runs.") {
			RoutineInstructionsField(text: $value, editable: editable, minHeight: 380, inset: 14)
			if editable {
				HStack {
					Spacer()
					Button("Done") { dismiss() }.buttonStyle(WebButtonStyle())
				}
			}
		}
	}
}
