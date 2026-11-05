import SwiftUI

/// You, the last tab, as the web's `You`: Settings, with your card leading to
/// your profile, the workspace's sections, its pods, other workspaces, Help
/// and docs, and Sign out.
@MainActor
struct YouScreen: View {
	@Environment(Session.self) private var session
	@Environment(WorkspaceStore.self) private var store
	@Environment(\.openURL) private var openURL
	@State private var members: Int?

	/// `projectLinks.documentation` in `packages/contracts`.
	static let documentation = URL(string: "https://sugabots.ai/docs")!

	var body: some View {
		let others = store.workspaces.filter { $0.id != store.workspace.id }
		ScrollView {
			VStack(alignment: .leading, spacing: 24) {
				SettingsListGroups(permissions: store.permissions, members: members)
				// No New workspace: a workspace is its own server now, found when signing in.
				if !others.isEmpty {
					SettingsGroup(label: "Other workspaces") {
						DividedRows(data: others) { other in
							Button { session.switchWorkspace(to: other) } label: {
								SettingsRow(label: other.name, chevron: true, leading: { LetterTile(name: other.name) })
							}
							.buttonStyle(SettingsRowPressStyle())
						}
					}
				}
				SettingsGroup {
					Button { openURL(Self.documentation) } label: {
						SettingsRow(label: "Help and docs", trailing: {
							Icon(.arrowUpRight, size: 16, strokeWidth: 2).foregroundStyle(Palette.subtleForeground)
						})
					}
					.buttonStyle(SettingsRowPressStyle())
					SettingsDivider()
					Button { Task { await session.signOut() } } label: {
						HStack {
							Text("Sign out").font(Typeface.rubik(16)).foregroundStyle(Palette.destructiveText)
							Spacer()
						}
						.padding(.horizontal, 16)
						.frame(minHeight: 56)
						.contentShape(Rectangle())
					}
					.buttonStyle(SettingsRowPressStyle())
				}
			}
			.padding(.horizontal, 16)
			.padding(.top, 6)
			.padding(.bottom, 24)
		}
		.safeAreaInset(edge: .top, spacing: 0) {
			Text("Settings")
				.font(Typeface.rubik(28, .semibold))
				.tracking(-0.56)
				.foregroundStyle(Palette.foreground)
				.frame(maxWidth: .infinity, alignment: .leading)
				.pageHeaderInsets(trailing: 8)
				.background(Palette.background)
				.accessibilityAddTraits(.isHeader)
		}
		.background(Palette.background.ignoresSafeArea())
		.task {
			await store.refreshAccess()
			// Hide the member count when you're the only member.
			let count = (try? await store.workspaceMembers())?.count
			members = count == 1 ? nil : count
		}
	}
}

/// The list You leads with, as the web's `SettingsListGroups`: your card, the
/// workspace's sections, then its pods and Personal pods.
@MainActor
private struct SettingsListGroups: View {
	let permissions: WorkspacePermissions?
	let members: Int?
	@Environment(WorkspaceStore.self) private var store

	var body: some View {
		let user = store.user
		NavigationLink(value: Route.settings(.profile)) {
			HStack(spacing: 16) {
				PersonAvatar(name: user.name, email: user.email, image: user.image, size: 64)
				VStack(alignment: .leading, spacing: 2) {
					Text(user.name).font(Typeface.rubik(20, .semibold)).foregroundStyle(Palette.foreground).lineLimit(1)
					Text("Profile and notifications").font(Typeface.rubik(14)).foregroundStyle(Palette.subtleForeground).lineLimit(1)
				}
				.frame(maxWidth: .infinity, alignment: .leading)
				Icon(.chevronRight, size: 18).foregroundStyle(Palette.subtleForeground)
			}
			.padding(16)
			.settingsCard()
			.contentShape(Rectangle())
		}
		.buttonStyle(.plain)

		let sections = WorkspaceSection.allCases.filter { section in
			permissions.map(section.allowed(by:)) ?? (section == .general || section == .members)
		}
		SettingsGroup(label: "Workspace") {
			DividedRows(data: sections, id: \.self) { section in
				NavigationLink(value: Route.settings(.workspace(section))) {
					SettingsRow(label: section.label, chevron: true, trailing: {
						if section == .members, let members { SettingsValue(text: "\(members)") }
					})
				}
				.buttonStyle(SettingsRowPressStyle())
			}
		}
		ForEach([("Pods", Pod.Kind.shared), ("Personal pods", .personal)], id: \.0) { label, kind in
			let pods = store.pods.filter { $0.kind == kind }
			if !pods.isEmpty {
				SettingsGroup(label: label) {
					DividedRows(data: pods) { pod in
						NavigationLink(value: Route.settings(.pod(pod))) {
							SettingsRow(label: pod.name, chevron: true, leading: { PodInitial(kind: pod.kind, name: pod.name, color: pod.color?.rawValue, size: .small) })
						}
						.buttonStyle(SettingsRowPressStyle())
					}
				}
			}
		}
	}
}

/// A pod's settings as You opens them, as the web's `YouPod`: its initial and
/// name, then a row for each of its pages, with how many of each it holds.
@MainActor
struct YouPodScreen: View {
	let pod: Pod
	@Environment(WorkspaceStore.self) private var store
	@State private var computers = false
	@State private var counts: [PodSettingsPage: Int] = [:]

	var body: some View {
		ScrollView {
			VStack(alignment: .leading, spacing: 24) {
				HStack(spacing: 12) {
					PodInitial(kind: pod.kind, name: pod.name, color: pod.color?.rawValue, size: .medium)
					Text(pod.name)
						.font(Typeface.rubik(28, .semibold))
						.tracking(-0.56)
						.foregroundStyle(Palette.foreground)
						.lineLimit(1)
				}
				.padding(.horizontal, 4)
				SettingsGroup {
					let pages = PodSettingsPage.pages(for: pod.kind, computersEnabled: computers)
					DividedRows(data: pages, id: \.self) { page in
						NavigationLink(value: Route.settings(.podPage(pod, page))) {
							SettingsRow(label: page.label, chevron: true, trailing: {
								if let count = counts[page] { SettingsValue(text: "\(count)") }
							})
						}
						.buttonStyle(SettingsRowPressStyle())
					}
				}
			}
			.padding(.horizontal, 16)
			.padding(.top, 6)
			.padding(.bottom, 24)
		}
		.safeAreaInset(edge: .top, spacing: 0) {
			HStack { PhoneBackButton(label: "Back to Settings"); Spacer() }
				.pageHeaderInsets()
		}
		.background(Palette.background.ignoresSafeArea())
		.toolbar(.hidden, for: .navigationBar)
		.task {
			computers = (try? await store.computersEnabled()) ?? false
			counts = await store.podCounts(pod)
		}
	}
}

extension WorkspaceStore {
	/// How many connections, people and bots a pod holds, as `usePodCounts`; none for an empty one.
	func podCounts(_ pod: Pod) async -> [PodSettingsPage: Int] {
		var counts: [PodSettingsPage: Int] = [:]
		let bots = bots(in: pod).count
		if bots > 0 { counts[.bots] = bots }
		if let connections = try? await connections(in: pod.id), !connections.isEmpty { counts[.connections] = connections.count }
		// Only you are ever in a personal pod, so there is nobody to count.
		if pod.kind == .shared, let people = try? await podMembers(pod.id), !people.isEmpty { counts[.people] = people.count }
		return counts
	}
}

/// A pod's initial on its colour, as the web's `PodInitial`: small on its tint,
/// larger on its swatch in dark type, or a person for a Personal pod.
struct PodInitial: View {
	enum Size {
		case small, medium, row, large
	}

	let kind: Pod.Kind
	let name: String
	let color: String?
	var size = Size.medium

	var body: some View {
		let palette = color.flatMap { BotLooks.pods[$0] }
		let (box, radius, font, icon): (CGFloat, CGFloat, CGFloat, CGFloat) =
			switch size {
			case .small: (16, 4, 10, 10)
			case .medium: (20, 5, 11, 11)
			// A settings row's mark, as the web's `size-7 rounded-[7px] text-xs`.
			case .row: (28, 7, 12, 14)
			case .large: (44, 11, 15, 20)
			}
		Group {
			if kind == .personal {
				Icon(.user, size: icon, strokeWidth: 2.25)
			} else {
				Text(Initials.first(of: name)).font(Typeface.rubik(font, .semibold))
			}
		}
		.foregroundStyle(palette == nil ? Palette.foreground : size == .small ? palette!.swatch : Color.black.opacity(0.8))
		.frame(width: box, height: box)
		.background(
			palette == nil ? Palette.tile : size == .small ? palette!.tile.resolved : palette!.swatch,
			in: RoundedRectangle(cornerRadius: radius, style: .continuous)
		)
		.accessibilityHidden(true)
	}
}

/// Another workspace's initial, white on black, as You lists them.
private struct LetterTile: View {
	let name: String

	var body: some View {
		Text(Initials.first(of: name))
			.font(Typeface.rubik(12, .semibold))
			.foregroundStyle(Palette.background)
			.frame(width: 24, height: 24)
			.background(Palette.foreground, in: RoundedRectangle(cornerRadius: 6, style: .continuous))
			.accessibilityHidden(true)
	}
}
