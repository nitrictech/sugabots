import SwiftUI

/// Notifications, as the web's `NotificationsSettings`: this device, what to
/// be told about, what else, pausing, quiet hours, and each pod's level.
@MainActor
struct NotificationsSettingsScreen: View {
	@Environment(WorkspaceStore.self) private var store
	@State private var settings: NotificationSettings?
	@State private var failure: String?

	var body: some View {
		SettingsPage(title: "Notifications", description: "What Sugabots tells you about, and when.") {
			ThisDevice()
			if let failure { FormAlert(text: failure) }
			if let settings {
				notifyAbout(settings)
				alsoNotifyAbout(settings)
				pause(settings)
				quietHours(settings)
				podLevels(settings)
			}
		}
		.task {
			do { settings = try await store.client.notifications.settings() } catch { failure = error.localizedDescription }
		}
	}

	// MARK: Groups

	private func notifyAbout(_ settings: NotificationSettings) -> some View {
		SettingsGroup(label: "Notify me about", note: NotificationLevel.notes[settings.level.rawValue]) {
			SettingsControlRow(label: "Notify me about", stacked: true) {
				SegmentedChoice(label: "Notify me about", options: NotificationLevel.known.map { ($0, $0.label) }, value: settings.level, fill: true) { level in
					update(settings, level: level)
				}
			}
		}
	}

	private static let routineRunOptions: [(RoutineRunNotifications, String)] = [(.failures, "Failed"), (.all, "Every run"), (.none, "None")]

	private func alsoNotifyAbout(_ settings: NotificationSettings) -> some View {
		SettingsGroup(label: "Also notify me when", note: "Runs of routines you made or started. Muting a pod or bot quiets these too.") {
			SettingsRow.trailing(label: "A bot can't finish its reply to me") {
				WebToggle(label: "A bot can't finish its reply to me", isOn: settings.turnFailures) { update(settings, turnFailures: $0) }
			}
			SettingsDivider()
			SettingsControlRow(label: "My routines run", stacked: true) {
				SegmentedChoice(label: "My routines run", options: Self.routineRunOptions.map { ($0.0, $0.1) }, value: settings.routineRuns, fill: true) {
					update(settings, routineRuns: $0)
				}
			}
		}
	}

	private func pause(_ settings: NotificationSettings) -> some View {
		let until = settings.pausedUntil.flatMap { $0 > .now ? $0 : nil }
		return SettingsGroup {
			SettingsRow.trailing(label: "Pause notifications", sub: until.map { "Paused until \(NotificationMenu.formatUntil($0))" }) {
				if until != nil {
					Button("Resume") { update(settings, pausedUntil: .some(nil)) }
						.buttonStyle(WebButtonStyle(variant: .secondary, size: .small))
				} else {
					Menu {
						ForEach(MuteDuration.all, id: \.label) { duration in
							Button(duration.label) { update(settings, pausedUntil: .some(duration.until(.now))) }
						}
					} label: {
						Text("Pause")
					}
					.buttonStyle(WebButtonStyle(variant: .secondary, size: .small))
				}
			}
		}
	}

	private func quietHours(_ settings: NotificationSettings) -> some View {
		let quiet = settings.quietHours
		let device = TimeZone.current.identifier
		return SettingsGroup(
			label: "Quiet hours",
			note: quiet.map { "No notifications between these times each day, in \($0.timeZone)." }
				?? "Turn off notifications overnight, or whenever you're not working."
		) {
			SettingsRow.trailing(label: "Quiet hours") {
				WebToggle(label: "Quiet hours", isOn: quiet != nil) { on in
					update(settings, quietHours: .some(on ? .init(from: Limits.defaultQuietHours.from, to: Limits.defaultQuietHours.to, timeZone: device) : nil))
				}
			}
			if let quiet {
				SettingsDivider()
				SettingsControlRow(label: "From") {
					TimeOfDayPicker(label: "From", value: quiet.from) { update(settings, quietHours: .some(.init(from: $0, to: quiet.to, timeZone: device))) }
				}
				SettingsDivider()
				SettingsControlRow(label: "To") {
					TimeOfDayPicker(label: "To", value: quiet.to) { update(settings, quietHours: .some(.init(from: quiet.from, to: $0, timeZone: device))) }
				}
			}
		}
	}

	@ViewBuilder
	private func podLevels(_ settings: NotificationSettings) -> some View {
		if !store.pods.isEmpty {
			SettingsGroup(
				label: "Pods",
				note: "A pod set to Default follows what you chose above. Right-click a pod or a bot in the sidebar to change it there; a bot's choice wins over its pod's."
			) {
				DividedRows(data: store.pods) { pod in
					SettingsRow.trailing(label: pod.name) { LevelPicker(place: .pod(id: pod.id), settings: settings, name: pod.name) { self.settings = $0 } }
				}
			}
		}
	}

	// MARK: Saving

	private func update(
		_ settings: NotificationSettings,
		level: NotificationLevel? = nil,
		pausedUntil: Date?? = nil,
		quietHours: QuietHours?? = nil,
		turnFailures: Bool? = nil,
		routineRuns: RoutineRunNotifications? = nil
	) {
		Task {
			do {
				self.settings = try await store.updateNotificationPreferences(
					level: level ?? settings.level,
					pausedUntil: pausedUntil ?? settings.pausedUntil,
					quietHours: quietHours ?? settings.quietHours,
					turnFailures: turnFailures ?? settings.turnFailures,
					routineRuns: routineRuns ?? settings.routineRuns
				)
				failure = nil
			} catch {
				failure = error.localizedDescription
			}
		}
	}
}

/// This device's notifications. The web turns them on per browser; the app
/// has no way to be notified yet, so it says so, as the web does where a
/// browser can't show them.
private struct ThisDevice: View {
	var body: some View {
		SettingsGroup(
			label: "This device",
			note: "The app can't show notifications yet. On an iPhone, add Sugabots to your Home Screen from Safari and turn them on there."
		) {
			SettingsRow.trailing(label: "Notifications", sub: "Each browser and device is turned on by itself, and notifies you while Sugabots is open in it.") {
				SettingsValue(text: "Not available")
			}
		}
	}
}

/// A time of day as `HH:MM`, chosen with the system's wheel.
private struct TimeOfDayPicker: View {
	let label: String
	let value: String
	let change: (String) -> Void

	var body: some View {
		DatePicker(label, selection: Binding(get: { date }, set: { change(Self.format($0)) }), displayedComponents: .hourAndMinute)
			.labelsHidden()
			.frame(maxWidth: .infinity, alignment: .trailing)
	}

	private var date: Date {
		let parts = value.split(separator: ":").compactMap { Int($0) }
		return Calendar.current.date(bySettingHour: parts.first ?? 0, minute: parts.last ?? 0, second: 0, of: .now) ?? .now
	}

	private static func format(_ date: Date) -> String {
		let parts = Calendar.current.dateComponents([.hour, .minute], from: date)
		return String(format: "%02d:%02d", parts.hour ?? 0, parts.minute ?? 0)
	}
}

/// A place's level in a settings row, and the menu that changes it, as `NotificationLevelPicker`.
@MainActor
struct LevelPicker: View {
	let place: NotificationPlace
	let settings: NotificationSettings
	let name: String
	let changed: (NotificationSettings) -> Void
	@Environment(WorkspaceStore.self) private var store

	var body: some View {
		let chosen = settings.levelChosen(for: place)
		let followed = settings.levelAbove(place)
		Menu {
			Button { set(nil) } label: {
				Label("Default (\(followed.label.lowercased()))", systemImage: chosen == nil ? "checkmark" : followed.symbol)
			}
			ForEach(NotificationLevel.known) { level in
				Button { set(level) } label: { Label(level.label, systemImage: chosen == level ? "checkmark" : level.symbol) }
			}
		} label: {
			HStack(spacing: 4) {
				Text(chosen?.label ?? "Default")
				Icon(.chevronDown, size: 14, strokeWidth: 2)
			}
			.font(Typeface.rubik(14))
			.foregroundStyle(Palette.mutedForeground)
		}
		.accessibilityLabel("Notifications for \(name)")
	}

	private func set(_ level: NotificationLevel?) {
		Task {
			try? await store.setNotificationLevel(level, for: place)
			if let updated = store.notificationSettings { changed(updated) }
		}
	}
}
