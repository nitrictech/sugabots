import SwiftUI

/// Notifications, as the web's `NotificationsSettings`: this device, what to
/// be told about, what else, pausing, quiet hours, and each pod's level.
/// Each change shows at once and is saved in turn, the latest last; a failed
/// save puts back what the server last agreed to.
@MainActor
struct NotificationsSettingsScreen: View {
	@Environment(WorkspaceStore.self) private var store
	@State private var settings: Loadable<NotificationSettings> = .loading
	/// The settings as the server last agreed to them.
	@State private var confirmed: NotificationSettings?
	/// The save under way, which the next waits for.
	@State private var saving: Task<Void, Never>?
	/// Counts changes, so a save can tell whether a newer one follows it.
	@State private var changeCount = 0
	@State private var actionFailure: String?

	var body: some View {
		SettingsPage(title: "Notifications", description: "What Sugabots tells you about, and when.") {
			ThisDevice()
			if let failure = actionFailure ?? settings.failure { FormAlert(text: failure) }
			if let settings = settings.value {
				notifyAbout(settings)
				alsoNotifyAbout(settings)
				pause(settings)
				quietHours(settings)
				podLevels(settings)
			}
		}
		.task {
			settings = await .of { try await store.client.notifications.settings() }
			confirmed = settings.value
		}
	}

	// MARK: Groups

	private func notifyAbout(_ settings: NotificationSettings) -> some View {
		SettingsGroup(label: "Notify me about", note: settings.level.note) {
			SettingsControlRow(label: "Notify me about", stacked: true) {
				SegmentedChoice(label: "Notify me about", options: NotificationLevel.known.map { ($0, $0.label) }, value: settings.level, fill: true) { level in
					update { $0.level = level }
				}
			}
		}
	}

	private static let routineRunOptions: [(RoutineRunNotifications, String)] = [(.failures, "Failed"), (.all, "Every run"), (.none, "None")]

	private func alsoNotifyAbout(_ settings: NotificationSettings) -> some View {
		SettingsGroup(label: "Also notify me when", note: "Runs of routines you made or started. Muting a pod or bot quiets these too.") {
			SettingsRow(label: "A bot can't finish its reply to me", trailing: {
				WebToggle(label: "A bot can't finish its reply to me", isOn: settings.turnFailures) { on in update { $0.turnFailures = on } }
			})
			SettingsDivider()
			SettingsControlRow(label: "My routines run", stacked: true) {
				SegmentedChoice(label: "My routines run", options: Self.routineRunOptions.map { ($0.0, $0.1) }, value: settings.routineRuns, fill: true) { runs in
					update { $0.routineRuns = runs }
				}
			}
		}
	}

	private func pause(_ settings: NotificationSettings) -> some View {
		let until = settings.pausedUntil.flatMap { $0 > .now ? $0 : nil }
		return SettingsGroup {
			SettingsRow(label: "Pause notifications", sub: until.map { "Paused until \(MuteDuration.formatUntil($0))" }, trailing: {
				if until != nil {
					Button("Resume") { update { $0.pausedUntil = nil } }
						.buttonStyle(WebButtonStyle(variant: .secondary, size: .small))
				} else {
					Menu {
						ForEach(MuteDuration.all, id: \.label) { duration in
							Button(duration.label) { update { $0.pausedUntil = duration.until(.now) } }
						}
					} label: {
						Text("Pause")
					}
					.buttonStyle(WebButtonStyle(variant: .secondary, size: .small))
				}
			})
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
			SettingsRow(label: "Quiet hours", trailing: {
				WebToggle(label: "Quiet hours", isOn: quiet != nil) { on in
					update { $0.quietHours = on ? QuietHours(from: Limits.defaultQuietHours.from, to: Limits.defaultQuietHours.to, timeZone: device) : nil }
				}
			})
			if let quiet {
				SettingsDivider()
				SettingsControlRow(label: "From") {
					TimeOfDayPicker(label: "From", value: quiet.from) { from in
						update { $0.quietHours = QuietHours(from: from, to: quiet.to, timeZone: device) }
					}
				}
				SettingsDivider()
				SettingsControlRow(label: "To") {
					TimeOfDayPicker(label: "To", value: quiet.to) { to in
						update { $0.quietHours = QuietHours(from: quiet.from, to: to, timeZone: device) }
					}
				}
			}
		}
	}

	@ViewBuilder
	private func podLevels(_ settings: NotificationSettings) -> some View {
		if !store.pods.isEmpty {
			SettingsGroup(
				label: "Pods",
				note: "A pod set to Default follows what you chose above. Touch and hold a pod or a bot on Home to change it there; a bot's choice wins over its pod's."
			) {
				DividedRows(data: store.pods) { pod in
					SettingsRow(label: pod.name, trailing: {
						LevelPicker(place: .pod(id: pod.id), settings: settings, name: pod.name) { result in
							switch result {
							case let .success(updated):
								self.settings = .loaded(updated)
								confirmed = updated
								actionFailure = nil
							case let .failure(error):
								actionFailure = error.localizedDescription
							}
						}
					})
				}
			}
		}
	}

	// MARK: Saving

	/// Applies `edit` to the settings shown, then saves them once any save under
	/// way has finished, unless a newer change has come in by then.
	private func update(_ edit: (inout NotificationSettings) -> Void) {
		guard var next = settings.value else { return }
		edit(&next)
		settings = .loaded(next)
		changeCount += 1
		let change = changeCount
		let previous = saving
		saving = Task {
			await previous?.value
			guard change == changeCount else { return }
			await save(next, change: change)
		}
	}

	private func save(_ next: NotificationSettings, change: Int) async {
		do {
			let saved = try await store.updateNotificationPreferences(
				level: next.level,
				pausedUntil: next.pausedUntil,
				quietHours: next.quietHours,
				turnFailures: next.turnFailures,
				routineRuns: next.routineRuns
			)
			confirmed = saved
			actionFailure = nil
			// A newer change is already shown, and will be saved next.
			if change == changeCount { settings = .loaded(saved) }
		} catch {
			actionFailure = error.localizedDescription
			if change == changeCount, let confirmed { settings = .loaded(confirmed) }
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
			SettingsRow(label: "Notifications", sub: "Each browser and device is turned on by itself, and notifies you while Sugabots is open in it.", trailing: {
				SettingsValue(text: "Not available")
			})
		}
	}
}

/// A time of day as `HH:MM`, chosen with the system's wheel. A turn of the
/// wheel is passed to `change` once it has rested, not at every step.
private struct TimeOfDayPicker: View {
	let label: String
	let value: String
	let change: (String) -> Void
	@State private var turning: String?

	/// How long the wheel rests before its time is passed on.
	private static var restDelay: Duration { .milliseconds(600) }

	var body: some View {
		DatePicker(label, selection: Binding(get: { Self.date(turning ?? value) }, set: { turning = Self.format($0) }), displayedComponents: .hourAndMinute)
			.labelsHidden()
			.frame(maxWidth: .infinity, alignment: .trailing)
			.task(id: turning) {
				guard let turning else { return }
				try? await Task.sleep(for: Self.restDelay)
				guard !Task.isCancelled else { return }
				self.turning = nil
				if turning != value { change(turning) }
			}
	}

	private static func date(_ time: String) -> Date {
		let parts = time.split(separator: ":").compactMap { Int($0) }
		return Calendar.current.date(bySettingHour: parts.first ?? 0, minute: parts.last ?? 0, second: 0, of: .now) ?? .now
	}

	private static func format(_ date: Date) -> String {
		let parts = Calendar.current.dateComponents([.hour, .minute], from: date)
		return String(format: "%02d:%02d", parts.hour ?? 0, parts.minute ?? 0)
	}
}

/// A place's level in a settings row, and the menu that changes it, as `NotificationLevelPicker`.
/// `changed` is told the settings as they stand after a change, or why it failed.
@MainActor
struct LevelPicker: View {
	let place: NotificationPlace
	let settings: NotificationSettings
	let name: String
	let changed: (Result<NotificationSettings, any Error>) -> Void
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
			do {
				changed(.success(try await store.setNotificationLevel(level, for: place)))
			} catch {
				changed(.failure(error))
			}
		}
	}
}
