import SwiftUI

/// Your profile, as the web's `ProfileSettings`: your name, email and theme,
/// Notifications, your invite link, and Sign out.
@MainActor
struct ProfileSettingsScreen: View {
	@Environment(Session.self) private var session
	@Environment(WorkspaceStore.self) private var store
	@AppStorage(Theme.storageKey) private var theme = Theme.dark

	var body: some View {
		let user = store.user
		SettingsPage(
			title: user.name,
			description: user.email,
			hero: AnyView(PersonAvatar(name: user.name, email: user.email, image: user.image, size: 44))
		) {
			SettingsGroup(label: "Account") {
				SettingsNameRow(name: user.name, maxLength: Limits.userNameMaxLength) { next in
					try await store.rename(to: next)
				}
				SettingsDivider()
				SettingsRow(label: "Email", trailing: { SettingsValue(text: user.email) })
			}
			SettingsGroup(label: "Appearance") {
				SettingsRow(label: "Theme", trailing: {
					SegmentedChoice(label: "Theme", options: Theme.allCases.map { ($0, $0.label) }, value: theme) { theme = $0 }
				})
			}
			SettingsGroup {
				NavigationLink(value: Route.settings(.notifications)) {
					SettingsRow(label: "Notifications", chevron: true)
				}
				.buttonStyle(SettingsRowPressStyle())
			}
			ReferralLinkGroup()
			SettingsDanger(label: "Sign out", description: "Signs you out on this device.", actionTitle: "Sign out") {
				Task { await session.signOut() }
			}
		}
	}
}

/// Your invite link, to copy, and a way to replace it, as `ReferralLinkSettings`.
@MainActor
private struct ReferralLinkGroup: View {
	@Environment(WorkspaceStore.self) private var store
	@State private var link: String?
	@State private var reset = SettingsAction()

	var body: some View {
		Group {
			if let link {
				VStack(alignment: .leading, spacing: 0) {
					VStack(alignment: .leading, spacing: 12) {
						VStack(alignment: .leading, spacing: 4) {
							Text("Share your invite link").font(Typeface.rubik(14, .medium)).foregroundStyle(Palette.foreground)
							Text("Anyone with it can sign up and get a workspace of their own.")
								.font(Typeface.rubik(12))
								.foregroundStyle(Palette.mutedForeground)
						}
						HStack(spacing: 10) {
							Text(link.replacingOccurrences(of: "^https?://", with: "", options: .regularExpression))
								.font(Typeface.mono(13))
								.foregroundStyle(Palette.foreground)
								.lineLimit(1)
								.truncationMode(.tail)
								.frame(maxWidth: .infinity, alignment: .leading)
							CopyButton(text: link) { copied in
								HStack(spacing: 6) {
									Icon(copied ? .check : .copy, size: 14)
									Text(copied ? "Copied" : "Copy")
								}
								.font(Typeface.rubik(13, .semibold))
								.foregroundStyle(Palette.background)
								.padding(.horizontal, 14)
								.frame(height: 29)
								.background(Palette.foreground, in: RoundedRectangle(cornerRadius: 8, style: .continuous))
							}
							.buttonStyle(.plain)
						}
						.padding(.leading, 14)
						.padding(.trailing, 6)
						.frame(height: 44)
						.background(Palette.background, in: RoundedRectangle(cornerRadius: 10, style: .continuous))
						.overlay(RoundedRectangle(cornerRadius: 10, style: .continuous).strokeBorder(Palette.settingsCardBorder))
					}
					.padding(16)
					.settingsCard()
					HStack(spacing: 12) {
						Text(reset.failure ?? "Shared it somewhere you shouldn't have?")
						Spacer()
						Button {
							reset.run { self.link = try await store.resetReferralLink() }
						} label: {
							HStack(spacing: 6) {
								Icon(.rotateCcw, size: 14)
								Text(reset.pending ? "Resetting…" : "Reset link")
							}
							.font(Typeface.rubik(12, .medium))
							.foregroundStyle(Palette.mutedForeground)
							.padding(.horizontal, 4)
							.padding(.vertical, 2)
						}
						.buttonStyle(.plain)
						.disabled(reset.pending)
					}
					.font(Typeface.rubik(13))
					.foregroundStyle(Palette.subtleForeground)
					.padding(.horizontal, 2)
					.padding(.top, 10)
				}
			}
		}
		.task { link = try? await store.referralLink() }
	}
}

/// The workspace's General, as the web's `GeneralSettings`: its name, which
/// those who may update the workspace rename where it stands, its time zone
/// and your access, and deleting it for its owner.
@MainActor
struct GeneralSettingsScreen: View {
	@Environment(Session.self) private var session
	@Environment(WorkspaceStore.self) private var store
	@State private var record: Workspace?
	@State private var members: Int?
	@State private var choosingTimeZone = false
	@State private var confirmingDelete = false

	var body: some View {
		let canUpdate = store.permissions?.updateWorkspace ?? false
		let name = store.workspace.name
		SettingsPage(title: "General", description: summary) {
			SettingsGroup {
				if canUpdate {
					SettingsNameRow(name: name, maxLength: Limits.workspaceNameMaxLength) { next in
						try await store.renameWorkspace(to: next)
					}
				} else {
					SettingsRow(label: "Name", trailing: { SettingsValue(text: name) })
				}
				SettingsDivider()
				Button { choosingTimeZone = true } label: {
					SettingsRow(label: "Time zone", sub: "Routines run on this clock", chevron: canUpdate, trailing: {
						SettingsValue(text: record?.timeZone ?? "")
					})
				}
				.buttonStyle(SettingsRowPressStyle())
				// The sheet starts from the zone the record holds, so it waits for it.
				.disabled(!canUpdate || record == nil)
				SettingsDivider()
				SettingsRow(label: "Your access", trailing: { SettingsValue(text: WorkspaceRole.label(store.role)) })
			}
			if store.permissions?.deleteWorkspace ?? false {
				SettingsDanger(label: "Delete workspace", description: "Removes every pod, bot and thread in \(name).", actionTitle: "Delete") {
					confirmingDelete = true
				}
			}
		}
		.fullScreenCover(isPresented: $choosingTimeZone) {
			if let record {
				TimeZoneSheet(current: record.timeZone) { Task { await load() } }
			}
		}
		.confirmDelete(
			isPresented: $confirmingDelete,
			title: "Delete \(name)?",
			description: "Its pods, bots, conversations and connections are deleted, and everyone in it loses it. This can't be undone."
		) {
			try await store.deleteWorkspace()
			await session.restore()
		}
		.task {
			await load()
			if record != nil, DebugSheet.timeZone.isWanted { choosingTimeZone = true }
		}
	}

	private var summary: String? {
		guard let members, record != nil else { return nil }
		let pods = store.pods.count
		let plural = { (count: Int, noun: String) in "\(count) \(noun)\(count == 1 ? "" : "s")" }
		return "Workspace with \(plural(members, "member")) and \(plural(pods, "pod"))"
	}

	private func load() async {
		async let record = try? store.workspaceRecord()
		async let accessRefreshed: Void = store.refreshAccess()
		async let members = try? store.workspaceMembers()
		self.record = await record
		await accessRefreshed
		self.members = await members?.count
	}
}

/// Choosing the workspace's time zone, as the web's `TimeZoneDialog`: this
/// device's zone and the regions, each opening its zones, or a search of all.
@MainActor
struct TimeZoneSheet: View {
	let current: String
	let saved: () -> Void
	@Environment(WorkspaceStore.self) private var store
	@Environment(\.dismiss) private var dismiss
	@State private var region: TimeZoneRegion?
	@State private var chosen: String?
	@State private var query = ""
	@State private var scheduled = 0
	@State private var saving = SettingsAction()

	private let choices = TimeZoneChoice.all(at: .now)

	var body: some View {
		let selected = chosen ?? current
		let moving = chosen != nil && chosen != current
		let needle = query.trimmingCharacters(in: .whitespaces).lowercased()
		DialogForm(
			title: region?.name ?? "Time zone",
			action: (title: saving.pending ? "Saving…" : "Save", run: save),
			actionDisabled: !moving || saving.pending,
			onBack: region == nil ? nil : { browse(nil) }
		) {
			SearchField(placeholder: "Search \(region?.name ?? "time zones")", text: $query)
			if needle.isEmpty, region == nil {
				if let device = choices.first(where: { $0.zone == TimeZone.current.identifier }) {
					SettingsGroup { zoneRow(device, selected: selected) }
				}
				SettingsGroup(label: "Regions") {
					let regions = TimeZoneRegion.of(choices)
					DividedRows(data: regions, id: \.name) { each in
						Button { browse(each) } label: {
							SettingsRow(label: each.name, chevron: true, trailing: {
								SettingsValue(text: each.choices.first { $0.zone == selected }?.place ?? "\(each.choices.count) zones")
							})
						}
						.buttonStyle(SettingsRowPressStyle())
					}
				}
			} else {
				let searched = (region?.choices ?? choices).filter { $0.matches(needle) }
				SettingsGroup {
					DividedRows(data: searched, id: \.zone) { choice in
						zoneRow(choice, selected: selected)
					}
					if searched.isEmpty {
						SettingsRow(label: "No time zone matches “\(query.trimmingCharacters(in: .whitespaces))”")
					}
				}
			}
			if scheduled > 0 {
				Text("All routines scheduled on \(TimeZoneChoice.place(of: current)) time will now run in whichever zone you pick.")
					.font(Typeface.rubik(13))
					.foregroundStyle(Palette.subtleForeground)
			}
			if let failure = saving.failure { FormAlert(text: failure) }
		}
		.task { scheduled = Int((try? await store.workspaceTimeZone())?.scheduledRoutines ?? 0) }
	}

	private func zoneRow(_ choice: TimeZoneChoice, selected: String) -> some View {
		Button { chosen = choice.zone } label: {
			SettingsRow(label: choice.place, sub: choice.zone, trailing: {
				SettingsValue(text: choice.offset)
				Icon(.check, size: 16, strokeWidth: 2.4)
					.foregroundStyle(Palette.foreground)
					.opacity(choice.zone == selected ? 1 : 0)
					.accessibilityLabel(choice.zone == selected ? "Chosen" : "")
			})
		}
		.buttonStyle(SettingsRowPressStyle())
	}

	private func browse(_ next: TimeZoneRegion?) {
		region = next
		query = ""
	}

	private func save() {
		guard let chosen, chosen != current else { return }
		saving.run {
			try await store.changeTimeZone(to: chosen)
			saved()
			dismiss()
		}
	}
}
