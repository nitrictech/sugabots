import SwiftUI

/// A routine beside its own thread, set up in place, as the web's
/// `RoutinePanel` on a phone: Back and ⋯ (Rename, Duplicate, Delete routine)
/// at the top, then whether it is on, what it is told, what starts it, where
/// its results go, and Run now. Somebody who may not manage its bot's
/// routines sees it without being able to change it.
@MainActor
struct RoutinePanel: View {
	let agent: Agent
	let pod: Pod
	/// The routine's own thread.
	let conversationId: String
	/// How the routine stands, as its thread knows it.
	let standing: ThreadDetails.Routine
	@Environment(WorkspaceStore.self) private var store
	@Environment(\.dismiss) private var dismiss
	@State private var routines: [Routine]?
	/// Paused or on as last changed here, until the thread's own standing catches up.
	@State private var stateOverride: RoutineState?
	@State private var pending = false
	@State private var failure: String?
	@State private var dialog: Dialog?
	@Environment(\.openPage) private var openPage
	@Environment(\.debugDialog) private var debugDialog

	private enum Dialog: Identifiable {
		case rename
		case instructions
		/// A trigger, by its id, or a new one while nil.
		case trigger(String?)
		case delete

		var id: String {
			switch self {
			case .rename: "rename"
			case .instructions: "instructions"
			case let .trigger(id): "trigger:\(id ?? "new")"
			case .delete: "delete"
			}
		}
	}

	var body: some View {
		let routine = routines?.first { $0.id == standing.id }
		let mayManage = pod.permissions.manageRoutines
		let active = (stateOverride ?? standing.state) == .enabled
		ScrollView {
			VStack(alignment: .leading, spacing: 0) {
				Text(routine?.name ?? "Routine")
					.font(Typeface.rubik(14, .semibold))
					.foregroundStyle(Palette.foreground)
					.lineLimit(1)
					.padding(.leading, 16)
					.padding(.trailing, 12)
					.frame(height: 52)
				VStack(alignment: .leading, spacing: 12) {
					if let failure { FormAlert(text: failure) }
					PanelCard {
						HStack(spacing: 10) {
							Circle().fill(active ? Palette.success : Palette.disabledForeground).frame(width: 6, height: 6)
							Text(active ? "Active" : standing.pausedAfterFailures ? "Paused after two failures" : "Paused")
								.font(Typeface.rubik(13))
								.foregroundStyle(Palette.foreground)
								.frame(maxWidth: .infinity, alignment: .leading)
							WebToggle(label: "Routine on", isOn: Binding(get: { active }, set: { on in
								control { try await setPaused(!on) }
							}))
							.disabled(!mayManage || pending)
						}
						.padding(.horizontal, 14)
						.frame(height: 48)
					}
					if let routine {
						instructions(routine, editable: mayManage)
						triggers(routine, editable: mayManage)
						PanelCard {
							VStack(spacing: 0) {
								HStack(spacing: 12) {
									Text("Also post result in the pod's channel")
										.font(Typeface.rubik(13))
										.foregroundStyle(Palette.foreground)
										.frame(maxWidth: .infinity, alignment: .leading)
									WebToggle(label: "Also post result in the pod's channel", isOn: Binding(
										get: { routine.results == .postToChat },
										set: { posted in update(routine, results: posted ? .postToChat : .keepInRun) }
									))
								}
								.padding(.horizontal, 14)
								.padding(.vertical, 10)
								.frame(minHeight: 48)
								if routine.results == .postToChat {
									RoutineChatRow(pod: pod, chatId: Binding(
										get: { routine.chatId },
										set: { chatId in update(routine, chatId: .some(chatId)) }
									))
								}
							}
							.disabled(!mayManage)
						}
					}
					if pod.permissions.runRoutines {
						Button {
							control { try await store.runRoutine(standing.id, agentId: agent.id) }
						} label: {
							HStack(spacing: 6) {
								Image(systemName: "play.fill").font(.system(size: 10))
								Text("Run now")
							}
							.frame(maxWidth: .infinity)
						}
						.buttonStyle(WebButtonStyle(variant: .secondary))
						.disabled(pending)
					}
				}
				.padding(.horizontal, 16)
				.padding(.top, 4)
				.padding(.bottom, 24)
			}
		}
		.safeAreaInset(edge: .top, spacing: 0) {
			HStack {
				PhoneBackButton()
				Spacer()
				if mayManage, let routine { moreMenu(routine) }
			}
			.pageHeaderInsets()
		}
		.background(Palette.background.ignoresSafeArea())
		.toolbar(.hidden, for: .navigationBar)
		.task {
			await load()
			openDebugDialog()
		}
		.fullScreenCover(item: Binding(get: { dialog.flatMap { if case .delete = $0 { nil } else { $0 } } }, set: { dialog = $0 })) { open in
			if let routine { sheet(open, routine: routine) }
		}
		.confirmDelete(
			isPresented: Binding(get: { if case .delete = dialog { true } else { false } }, set: { if !$0 { dialog = nil } }),
			title: "Delete \(routine?.name ?? "")?",
			description: "It stops running. Runs already in its bot's chat stay there."
		) {
			try await store.deleteRoutine(standing.id, agentId: agent.id)
			dismiss()
		}
	}

	private func moreMenu(_ routine: Routine) -> some View {
		Menu {
			Button { dialog = .rename } label: { Label("Rename", systemImage: "pencil") }
			Button { duplicate(routine) } label: { Label("Duplicate", systemImage: "doc.on.doc") }.disabled(pending)
			Button(role: .destructive) { dialog = .delete } label: { Label("Delete routine", systemImage: "trash") }
		} label: {
			GlassRoundIcon(icon: .ellipsis)
		}
		.accessibilityLabel("More for \(routine.name)")
	}

	/// What the routine tells its bot: a row that opens them all to change, or the text itself for those who may not.
	@ViewBuilder private func instructions(_ routine: Routine, editable: Bool) -> some View {
		if editable {
			Button { dialog = .instructions } label: {
				PanelCard {
					HStack(spacing: 8) {
						VStack(alignment: .leading, spacing: 2) {
							Text("Instructions").font(Typeface.rubik(13)).foregroundStyle(Palette.mutedForeground)
							Text(routine.instructions).font(Typeface.rubik(14)).foregroundStyle(Palette.softForeground).lineLimit(1)
						}
						.frame(maxWidth: .infinity, alignment: .leading)
						Icon(.chevronRight, size: 16).foregroundStyle(Palette.subtleForeground)
					}
					.padding(.horizontal, 14)
					.padding(.vertical, 12)
				}
				.contentShape(Rectangle())
			}
			.buttonStyle(.plain)
			.accessibilityLabel("Edit instructions")
		} else {
			FoldedInstructions(text: routine.instructions)
		}
	}

	private func triggers(_ routine: Routine, editable: Bool) -> some View {
		VStack(alignment: .leading, spacing: 8) {
			Text("Triggers").font(Typeface.rubik(13)).foregroundStyle(Palette.mutedForeground).padding(.horizontal, 2)
			PanelCard {
				VStack(spacing: 0) {
					if routine.triggers.isEmpty {
						Text("None. It runs only when someone runs it.")
							.font(Typeface.rubik(13))
							.foregroundStyle(Palette.mutedForeground)
							.frame(maxWidth: .infinity, alignment: .leading)
							.padding(.horizontal, 14)
							.padding(.vertical, 12)
					}
					DividedRows(data: routine.triggers, id: \.id) { trigger in
						triggerRow(
							mark: AnyView(TriggerKindMark(kind: trigger.kind)),
							label: TriggerKindChoice.of(trigger.kind).label,
							sub: ScheduleWords.triggerLabel(trigger.input),
							action: editable ? { dialog = .trigger(trigger.id) } : nil
						)
					}
					if editable {
						SettingsDivider()
						triggerRow(
							mark: AnyView(SettingsRowIcon { Icon(.plus, size: 14, strokeWidth: 2) }),
							label: "Add trigger",
							sub: nil,
							action: { dialog = .trigger(nil) }
						)
					}
				}
			}
		}
		.padding(.top, 4)
	}

	@ViewBuilder private func triggerRow(mark: AnyView, label: String, sub: String?, action: (() -> Void)?) -> some View {
		let row = HStack(spacing: 10) {
			mark
			VStack(alignment: .leading, spacing: 0) {
				Text(label).font(Typeface.rubik(13)).foregroundStyle(Palette.foreground).lineLimit(1)
				if let sub { Text(sub).font(Typeface.rubik(12)).foregroundStyle(Palette.mutedForeground).lineLimit(1) }
			}
			.frame(maxWidth: .infinity, alignment: .leading)
			if action != nil, sub != nil { Icon(.chevronRight, size: 14, strokeWidth: 2.2).foregroundStyle(Palette.subtleForeground) }
		}
		.padding(.horizontal, 12)
		.padding(.vertical, 8)
		.contentShape(Rectangle())
		if let action {
			Button(action: action) { row }.buttonStyle(PressableRowStyle(pressed: Palette.rowHover))
		} else {
			row
		}
	}

	@ViewBuilder private func sheet(_ open: Dialog, routine: Routine) -> some View {
		switch open {
		case .rename:
			NameSheet(
				title: "Rename routine",
				name: routine.name,
				action: "Save",
				placeholder: "e.g. Friday pipeline review",
				maxLength: Limits.maxRoutineNameCharacters
			) { name in
				_ = try await store.updateRoutine(routine.id, agentId: agent.id, name: name)
				await load()
				dialog = nil
			}
		case .instructions:
			InstructionsSheet(botName: agent.name, instructions: routine.instructions) { instructions in
				_ = try await store.updateRoutine(routine.id, agentId: agent.id, instructions: instructions)
				await load()
				dialog = nil
			}
		case let .trigger(triggerId):
			triggerSheet(routine: routine, triggerId: triggerId)
		case .delete:
			EmptyView()
		}
	}

	/// One of the routine's triggers, or a new one. A webhook's address and secret save as they change, so its sheet is Done.
	@ViewBuilder private func triggerSheet(routine: Routine, triggerId: String?) -> some View {
		let editing = routine.triggers.first { $0.id == triggerId }
		let save: (TriggerInput) async throws -> Void = { input in
			if let editing {
				_ = try await store.updateTrigger(editing.id, with: input, routineId: routine.id, agentId: agent.id)
			} else {
				_ = try await store.addTrigger(input, to: routine.id, agentId: agent.id)
			}
			await load()
		}
		let remove: (() async throws -> Void)? = editing.map { editing in
			{
				_ = try await store.removeTrigger(editing.id, routineId: routine.id, agentId: agent.id)
				await load()
			}
		}
		if let editing, case let .webhook(webhook) = editing {
			TriggerSheet(pod: pod, editing: TriggerDraft.of(editing.input), settings: {
				WebhookGroups(agent: agent, pod: pod, routineId: routine.id, triggerId: editing.id, auth: WebhookAuthChoice(webhook.auth)) { auth in
					Task {
						_ = try? await store.updateTrigger(editing.id, with: .webhook(auth: auth, secret: nil), routineId: routine.id, agentId: agent.id)
						await load()
					}
				}
			}, save: save, remove: remove)
		} else {
			TriggerSheet(pod: pod, editing: editing.map { TriggerDraft.of($0.input) }, save: save, remove: remove)
		}
	}

	private func load() async {
		if let loaded = try? await store.routines(of: agent.id) { routines = loaded }
	}

	/// In a development build, the dialog `SUGABOTS_OPEN` names, so it can be screenshotted.
	private func openDebugDialog() {
		guard let routine = routines?.first(where: { $0.id == standing.id }) else { return }
		switch debugDialog {
		case "rename": dialog = .rename
		case "instructions": dialog = .instructions
		case "delete": dialog = .delete
		case "trigger": dialog = .trigger(routine.triggers.first { $0.kind == "cron" }?.id)
		case "webhook": dialog = .trigger(routine.triggers.first { $0.kind == "webhook" }?.id)
		default: break
		}
	}

	private func setPaused(_ paused: Bool) async throws {
		_ = try await store.updateRoutine(standing.id, agentId: agent.id, state: paused ? .paused : .enabled)
		stateOverride = paused ? .paused : .enabled
	}

	private func control(_ work: @escaping () async throws -> Void) {
		pending = true
		failure = nil
		Task {
			do { try await work() } catch { failure = error.localizedDescription }
			pending = false
		}
	}

	private func update(_ routine: Routine, results: RoutineResults? = nil, chatId: String?? = nil) {
		control {
			_ = try await store.updateRoutine(routine.id, agentId: agent.id, results: results, chatId: chatId)
			await load()
		}
	}

	private func duplicate(_ routine: Routine) {
		control {
			let copy = routine.copy(siblingNames: (routines ?? []).map(\.name))
			let created = try await store.createRoutine(agentId: agent.id, routine: copy)
			openPage(.routine(pod, routineId: created.routine.id))
		}
	}
}

/// A card in the panel: one of the routine's settings or a group of them.
private struct PanelCard<Content: View>: View {
	@ViewBuilder var content: Content

	var body: some View {
		content
			.frame(maxWidth: .infinity, alignment: .leading)
			.background(Palette.card)
			.clipShape(RoundedRectangle(cornerRadius: 12, style: .continuous))
			.overlay(RoundedRectangle(cornerRadius: 12, style: .continuous).strokeBorder(Palette.border))
	}
}

/// Instructions for someone who may not change them: folded to four lines past 200 characters until asked for the rest.
private struct FoldedInstructions: View {
	let text: String
	@State private var open = false

	private static let foldedOver = 200

	var body: some View {
		let folds = text.count > Self.foldedOver
		PanelCard {
			VStack(alignment: .leading, spacing: 6) {
				Text("Instructions").font(Typeface.rubik(13)).foregroundStyle(Palette.mutedForeground)
				Text(text).font(Typeface.rubik(13)).lineSpacing(4).foregroundStyle(Palette.softForeground).lineLimit(folds && !open ? 4 : nil)
				if folds {
					ShowMoreButton(open: $open)
				}
			}
			.padding(.horizontal, 14)
			.padding(.top, 12)
			.padding(.bottom, 14)
		}
	}
}

/// What the routine tells its bot each time it runs, with room to write.
private struct InstructionsSheet: View {
	let botName: String
	let instructions: String
	let save: (String) async throws -> Void
	@State private var draft = ""
	@State private var saving = false
	@State private var failure: String?

	var body: some View {
		let next = draft.trimmingCharacters(in: .whitespacesAndNewlines)
		DialogForm(title: "Instructions", action: saving ? "Saving…" : "Save", actionDisabled: saving || next.isEmpty || next == instructions, gap: 12, submit: {
			saving = true
			failure = nil
			Task {
				do { try await save(next) } catch { failure = error.localizedDescription }
				saving = false
			}
		}) {
			Text("What \(botName) does each time this runs.")
				.font(Typeface.rubik(13))
				.foregroundStyle(Palette.mutedForeground)
				.frame(maxWidth: .infinity)
			RoutineInstructionsField(text: $draft, minHeight: 240, inset: 12)
			if let failure { FormAlert(text: failure) }
		}
		.onAppear { draft = instructions }
	}
}

/// An existing webhook trigger's groups: its address and where it comes from,
/// then its auth, which saves as it changes, and its secret, which saves when
/// the field is left, under what a caller must send.
@MainActor
struct WebhookGroups: View {
	let agent: Agent
	let pod: Pod
	let routineId: String
	let triggerId: String
	let auth: WebhookAuthChoice
	let changeAuth: (WebhookAuthChoice) -> Void
	@Environment(WorkspaceStore.self) private var store
	@Environment(Toaster.self) private var toaster
	@State private var saved: RoutineCurrentSecret?
	@State private var draft = ""
	@State private var rotateFailure: String?

	var body: some View {
		Group { groups }.task { await loadSecret() }
	}

	@ViewBuilder private var groups: some View {
		let canManage = pod.permissions.manageRoutines
		let address = store.webhookAddress(of: triggerId)
		SettingsGroup {
			SettingsControlRow(label: "Address") {
				Text(address).font(Typeface.mono(13)).foregroundStyle(Palette.foreground).lineLimit(1).truncationMode(.middle)
				Spacer(minLength: 0)
				Button {
					UIPasteboard.general.string = address
					toaster.show("Copied")
				} label: { Icon(.copy, size: 15).frame(width: 30, height: 30) }
					.buttonStyle(IconPressStyle())
					.accessibilityLabel("Copy address")
			}
			SettingsDivider()
			WebhookSourceRow(auth: Binding(get: { auth }, set: changeAuth))
		}
		if canManage, let saved {
			let hasSecret = if case .none = saved { false } else { true }
			let savedSecret = if case let .set(set) = saved { set.secret } else { "" }
			let next = draft.trimmingCharacters(in: .whitespaces)
			let ready = WebhookDraft(auth: auth, secret: next).secretReady
			SettingsGroup(note: hasSecret ? auth.note : WebhookDraft.noSecretNote) {
				WebhookAuthRows(auth: Binding(get: { auth }, set: changeAuth))
				SettingsDivider()
				SecretFieldRow(
					label: auth.secretLabel,
					placeholder: auth.secretPlaceholder,
					value: $draft,
					error: rotateFailure ?? (ready ? nil : WebhookDraft.secretTooShortNote),
					onCommit: { commit(next: next, saved: savedSecret, ready: ready) }
				)
			}
		} else {
			SettingsGroup(note: auth.note) {
				WebhookAuthRows(auth: Binding(get: { auth }, set: changeAuth))
				SettingsDivider()
				SettingsControlRow(label: auth.secretLabel) {
					if !canManage {
						Text("Set by people who manage routines").font(Typeface.rubik(14)).foregroundStyle(Palette.mutedForeground).lineLimit(1)
					}
					Spacer(minLength: 0)
				}
			}
		}
	}

	private func commit(next: String, saved: String, ready: Bool) {
		guard next != saved, ready else { return }
		Task {
			do {
				rotateFailure = nil
				_ = try await store.replaceWebhookSecret(of: triggerId, routineId: routineId, agentId: agent.id, with: next.isEmpty ? nil : next, none: next.isEmpty)
				await loadSecret()
			} catch {
				rotateFailure = error.localizedDescription
			}
		}
	}

	private func loadSecret() async {
		guard pod.permissions.manageRoutines else { return }
		saved = try? await store.webhookSecret(of: triggerId, routineId: routineId, agentId: agent.id)
		if case let .set(set) = saved { draft = set.secret } else { draft = "" }
	}
}
