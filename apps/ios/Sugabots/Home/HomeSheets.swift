import SwiftUI

/// Naming something, new or renamed, in a dialog with one field: a channel,
/// as the web's `ChatNameDialog`, or a routine, as its `RenameDialog`.
@MainActor
struct NameSheet: View {
	let title: String
	/// The name it has now; empty for something new.
	var name = ""
	let action: String
	let placeholder: String
	let maxLength: Int
	/// A line under the field, such as who will read it.
	var note: String?
	let save: (String) async throws -> Void
	@State private var draft = ""
	@State private var saving = false
	@State private var failure: String?

	var body: some View {
		let next = draft.trimmingCharacters(in: .whitespaces)
		DialogForm(title: title, action: action, actionDisabled: saving || next.isEmpty || next == name, gap: 12, submit: submit) {
			SettingsGroup {
				SettingsFieldRow(label: "Name", value: $draft, placeholder: placeholder, maxLength: maxLength)
			}
			if let note {
				Text(note)
					.font(Typeface.rubik(12.5))
					.foregroundStyle(Palette.subtleForeground)
					.padding(.horizontal, 4)
			}
			if let failure { FormAlert(text: failure) }
		}
		.onAppear { draft = name }
	}

	private func submit() {
		let trimmed = draft.trimmingCharacters(in: .whitespaces)
		guard !trimmed.isEmpty, !saving else { return }
		saving = true
		failure = nil
		Task {
			do {
				try await save(trimmed)
			} catch let failure as APIFailure where failure.status == 403 {
				self.failure = "Only someone who runs this pod can do that."
			} catch {
				failure = error.localizedDescription
			}
			saving = false
		}
	}
}

extension NameSheet {
	/// As `CHAT_NAME_MAX_LENGTH` in `@sugabots/contracts`.
	nonisolated private static let maxChannelNameLength = 64

	/// Naming a pod's channel, as the web's `ChatNameDialog`.
	nonisolated static func channel(title: String, name: String = "", action: String, save: @escaping (String) async throws -> Void) -> NameSheet {
		NameSheet(
			title: title,
			name: name,
			action: action,
			placeholder: "e.g. Pricing",
			maxLength: maxChannelNameLength,
			note: "Everyone in the pod can read and write in it.",
			save: save
		)
	}
}

/// Renaming or archiving one of a pod's channels, which holding it on Home
/// and its Details both offer.
enum ChannelChange {
	case rename(PodChat)
	case archive(PodChat)

	/// Whether the person may rename the channels of `pod`.
	static func mayRename(in pod: Pod) -> Bool { pod.permissions.rename }

	/// Whether the person may archive `channel`: as renaming it, but never the pod's first.
	static func mayArchive(_ channel: PodChat, in pod: Pod) -> Bool { mayRename(in: pod) && !channel.main }
}

extension View {
	/// The sheet that renames a channel and the dialog that archives it, open
	/// while `change` names one. `archived` runs once a channel is archived
	/// and its dialog has closed.
	func channelChange(_ change: Binding<ChannelChange?>, in pod: Pod, archived: @escaping () -> Void = {}) -> some View {
		modifier(ChannelChangeDialogs(change: change, pod: pod, archived: archived))
	}
}

@MainActor
private struct ChannelChangeDialogs: ViewModifier {
	@Binding var change: ChannelChange?
	let pod: Pod
	let archived: () -> Void
	@Environment(WorkspaceStore.self) private var store
	/// Whether the dialog closes on a channel it archived, so `archived` runs once it has gone.
	@State private var archivedOne = false

	func body(content: Content) -> some View {
		content
			.sheet(item: Binding(get: { if case let .rename(channel) = change { channel } else { nil } }, set: { if $0 == nil { change = nil } })) { channel in
				NameSheet.channel(title: "Rename channel", name: channel.title, action: "Save") { renamed in
					try await store.renameChat(channel.id, to: renamed, in: pod)
					change = nil
				}
			}
			.confirmDelete(
				isPresented: Binding(get: { archiving != nil }, set: { presented in
					guard !presented else { return }
					change = nil
					if archivedOne {
						archivedOne = false
						archived()
					}
				}),
				title: "Archive \(archiving?.title ?? "")?",
				description: "It leaves the pod's list for everyone. Threads started from it stay.",
				confirmLabel: "Archive"
			) {
				guard let archiving else { return }
				try await store.archiveChat(archiving.id, in: pod)
				archivedOne = true
			}
	}

	private var archiving: PodChat? {
		if case let .archive(channel) = change { channel } else { nil }
	}
}

/// Making a pod, as the web's `NewPodDialog`: its name and colour, over a preview of its tile.
@MainActor
struct NewPodSheet: View {
	let created: (Pod) -> Void
	@Environment(WorkspaceStore.self) private var store
	@State private var name = ""
	@State private var chosenColor: String?
	@State private var creating = false
	@State private var failure: String?

	/// As `POD_NAME_MAX_LENGTH` in `@sugabots/contracts`.
	private static let maxLength = 64

	var body: some View {
		let color = chosenColor ?? leastUsedColor
		let usable = !Self.slug(name).isEmpty
		DialogForm(title: "New pod", action: "Create", actionDisabled: !usable || creating, gap: 12, submit: submit) {
			HStack {
				Spacer()
				PodTile(pod: preview(color: color), size: 64, cornerRadius: 16)
				Spacer()
			}
			.padding(.top, 4)
			.padding(.bottom, 8)
			SettingsGroup(note: "You'll add bots, people and connections next.") {
				SettingsFieldRow(label: "Name", value: $name, placeholder: "e.g. Support", maxLength: Self.maxLength)
				SettingsDivider()
				SettingsControlRow(label: "Colour", stacked: true) {
					ColourSwatches(colors: PodColor.known.map(\.rawValue), swatch: { BotLooks.pods[$0]?.swatch ?? .gray }, value: color) { chosenColor = $0 }
				}
			}
			if let failure { FormAlert(text: failure) }
		}
	}

	/// The colour fewest pods have, as `leastUsedPodColor` picks it.
	private var leastUsedColor: String {
		let uses = { (color: String) in store.pods.filter { $0.color?.rawValue == color }.count }
		let colors = PodColor.known.map(\.rawValue)
		return colors.reduce(colors[0]) { uses($1) < uses($0) ? $1 : $0 }
	}

	/// The pod as the rail will show it: its initial, once named, on its colour.
	private func preview(color: String) -> Pod {
		Pod(
			id: "", workspaceId: store.workspace.id, kind: .shared, name: name.isEmpty ? " " : name, slug: "",
			color: PodColor(rawValue: color), permissions: .none, createdAt: .now
		)
	}

	/// As `slugify` in `@sugabots/contracts`: a pod needs a name with a letter or digit in it.
	private static func slug(_ name: String) -> String {
		name.lowercased().replacingOccurrences(of: "[^a-z0-9]+", with: "-", options: .regularExpression)
			.trimmingCharacters(in: CharacterSet(charactersIn: "-"))
	}

	private func submit() {
		guard !Self.slug(name).isEmpty, !creating else { return }
		creating = true
		failure = nil
		Task {
			do {
				created(try await store.createPod(named: name, color: PodColor(rawValue: chosenColor ?? leastUsedColor)))
			} catch let failure as APIFailure where failure.status == 409 {
				self.failure = "A pod with that name already exists. Try another name."
			} catch let failure as APIFailure where failure.status == 403 {
				self.failure = "Only a workspace admin can create a pod."
			} catch {
				failure = error.localizedDescription
			}
			creating = false
		}
	}
}

/// A pod's or bot's notifications, as the web's context menu offers them:
/// the level to follow or choose, then muting it for a while and the way to
/// every notification setting. Empty until the person's notification
/// settings have loaded.
@MainActor
struct NotificationMenu: View {
	let place: NotificationPlace
	@Environment(WorkspaceStore.self) private var store
	@Environment(Toaster.self) private var toaster
	@Environment(\.openPage) private var openPage

	var body: some View {
		if let settings = store.notificationSettings {
			menu(settings)
		}
	}

	@ViewBuilder private func menu(_ settings: NotificationSettings) -> some View {
		let chosen = settings.levelChosen(for: place)
		let followed = settings.levelAbove(place)
		Section("Notify you about…") {
			Button { setLevel(nil) } label: {
				Label("Default (\(followed.label.lowercased()))", systemImage: chosen == nil ? "checkmark" : followed.symbol)
			}
			ForEach(NotificationLevel.known) { level in
				Button { setLevel(level) } label: {
					Label(level.label, systemImage: chosen == level ? "checkmark" : level.symbol)
				}
			}
		}
		Menu {
			if let until = settings.mutedUntil(place) {
				Button { mute(until: nil) } label: {
					Label("Unmute · Muted until \(Self.formatUntil(until))", systemImage: "bell")
				}
			} else if (chosen ?? followed) != .nothing {
				ForEach(MuteDuration.all, id: \.label) { duration in
					Button { mute(until: duration.until(.now)) } label: {
						Label("Mute \(duration.label.lowercased())", systemImage: "clock")
					}
				}
			}
			Divider()
			Button { openPage(.settings(.notifications)) } label: { Label("Notification settings", systemImage: "gearshape") }
		} label: {
			Label("More options", systemImage: "ellipsis")
		}
	}

	private func setLevel(_ level: NotificationLevel?) {
		Task {
			do { try await store.setNotificationLevel(level, for: place) } catch { toaster.show(error.localizedDescription) }
		}
	}

	private func mute(until: Date?) {
		Task {
			do { try await store.mute(place, until: until) } catch { toaster.show(error.localizedDescription) }
		}
	}

	/// As `formatUntil`: a time today, or a weekday and time after.
	static func formatUntil(_ until: Date) -> String {
		Calendar.current.isDateInToday(until)
			? until.formatted(date: .omitted, time: .shortened)
			: until.formatted(.dateTime.weekday(.abbreviated).hour().minute())
	}
}

/// How long a pause or a mute lasts, as Slack offers them.
struct MuteDuration {
	let label: String
	let until: (Date) -> Date

	/// The hour a mute until tomorrow ends, on this device's clock.
	private static let morningHour = 9

	static let all = [
		MuteDuration(label: "For 30 minutes") { $0.addingTimeInterval(30 * 60) },
		MuteDuration(label: "For 1 hour") { $0.addingTimeInterval(60 * 60) },
		MuteDuration(label: "For 2 hours") { $0.addingTimeInterval(2 * 60 * 60) },
		MuteDuration(label: "Until tomorrow") { now in
			let tomorrow = Calendar.current.date(byAdding: .day, value: 1, to: now) ?? now
			return Calendar.current.date(bySettingHour: morningHour, minute: 0, second: 0, of: tomorrow) ?? tomorrow
		},
	]
}
