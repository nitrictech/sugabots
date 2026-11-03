import SwiftUI

/// People, as the web's `WorkspaceMembersSettings` roster: everyone in the
/// workspace, who's invited, and Invite people for those who may.
@MainActor
struct MembersSettingsScreen: View {
	@Environment(WorkspaceStore.self) private var store
	@State private var members: [WorkspaceMember]?
	@State private var invitations: [WorkspaceInvitation] = []
	@State private var failed = false
	@State private var inviting = false

	var body: some View {
		let canManage = store.permissions?.manageMembers ?? false
		SettingsPage(title: "People", description: "Everyone in the workspace. Add them to pods to give them bots.") {
			if canManage { SettingsAddButton(label: "Invite people") { inviting = true } }
		} content: {
			if failed {
				FormAlert(text: "Members could not be loaded. Reload this page to try again.")
			} else if let members {
				SettingsGroup(label: "Members") {
					DividedRows(data: members) { member in
						NavigationLink(value: Route.settings(.member(id: member.id))) {
							SettingsRow(
								label: member.user.id == store.user.id ? "\(member.user.name) (you)" : member.user.name,
								sub: member.user.email,
								chevron: true,
								leading: { PersonAvatar(name: member.user.name, email: member.user.email, image: member.user.image, size: 24) },
								trailing: { SettingsValue(text: member.role.label) }
							)
						}
						.buttonStyle(SettingsRowPressStyle())
					}
				}
			} else {
				SettingsNotice(text: "Loading members…")
			}
			if !invitations.isEmpty {
				InvitationsGroup(invitations: invitations, canManage: canManage) { await load() }
			}
		}
		.fullScreenCover(isPresented: $inviting) {
			InviteSheet(canManageAdmins: store.permissions?.manageAdmins ?? false) { await load() }
		}
		.task {
			await load()
			if DebugSheet.wants("invite") { inviting = true }
		}
	}

	private func load() async {
		await store.refreshAccess()
		do {
			members = try await store.workspaceMembers()
		} catch {
			failed = true
		}
		invitations = (try? await store.invitations()) ?? []
	}
}

/// Who's invited, with Resend and Revoke for those who may.
@MainActor
private struct InvitationsGroup: View {
	let invitations: [WorkspaceInvitation]
	let canManage: Bool
	let changed: () async -> Void
	@Environment(WorkspaceStore.self) private var store
	@State private var resent: Set<String> = []
	@State private var pending = false
	@State private var failure: String?

	/// As `INVITE_LIFETIME_DAYS`.
	private static let lifetimeDays = 2

	var body: some View {
		SettingsGroup(label: "Invited", note: "Invites expire after \(Self.lifetimeDays) days.") {
			DividedRows(data: invitations) { invitation in
				SettingsRow(
					label: invitation.email,
					sub: resent.contains(invitation.id) ? "Sent again" : Self.expiry(invitation.expiresAt),
					leading: { PersonAvatar(name: invitation.email, email: invitation.email, size: 32) },
					trailing: {
						if canManage {
							HStack(spacing: 4) {
								Button("Resend") { resend(invitation) }
									.buttonStyle(WebButtonStyle(variant: .secondary, size: .small))
								Button { revoke(invitation) } label: {
									Icon(.x, size: 14).frame(width: 24, height: 24).contentShape(Circle())
								}
								.buttonStyle(IconPressStyle())
								.accessibilityLabel("Revoke the invitation for \(invitation.email)")
							}
							.disabled(pending)
						}
					}
				)
			}
			if let failure {
				SettingsDivider()
				FormAlert(text: failure).padding(.horizontal, 16).padding(.vertical, 12)
			}
		}
	}

	private static func expiry(_ expiresAt: Date) -> String {
		let left = expiresAt.timeIntervalSinceNow
		if left <= 0 { return "Expired" }
		let days = Int(left / 86_400)
		if days == 0 { return "Expires within a day" }
		return days == 1 ? "Expires in 1 day" : "Expires in \(days) days"
	}

	private func resend(_ invitation: WorkspaceInvitation) {
		act {
			try await store.invite(invitation.email, as: invitation.role, resend: true)
			resent.insert(invitation.id)
		}
	}

	private func revoke(_ invitation: WorkspaceInvitation) {
		act {
			try await store.cancelInvitation(invitation)
			await changed()
		}
	}

	private func act(_ work: @escaping () async throws -> Void) {
		pending = true
		Task {
			do {
				try await work()
				failure = nil
			} catch {
				failure = error.localizedDescription
			}
			pending = false
		}
	}
}

/// The roles one may give, as `roleOptions`: Admin only for those who may make admins.
private func roleOptions(canManageAdmins: Bool) -> [(value: WorkspaceRole, label: String)] {
	WorkspaceRole.assignable.filter { canManageAdmins || $0 != .admin }.map { ($0, $0.label) }
}

/// Inviting people by email, as the web's `InviteDialog`: every address
/// given, in one role; what fails is left to fix and send again.
@MainActor
private struct InviteSheet: View {
	let canManageAdmins: Bool
	let sent: () async -> Void
	@Environment(WorkspaceStore.self) private var store
	@Environment(\.dismiss) private var dismiss
	@State private var text = ""
	@State private var role = WorkspaceRole.member
	@State private var failed: [InviteFailure] = []
	@State private var sending = false

	var body: some View {
		let emails = inviteEntries(in: text)
		DialogForm(title: "Invite people", action: "Send", actionDisabled: sending || emails.isEmpty, closable: !sending, submit: { send(emails) }) {
			TextField("", text: $text, prompt: Text("Email addresses, separated by commas").foregroundStyle(Palette.mutedForeground))
				.font(Typeface.rubik(16))
				.keyboardType(.emailAddress)
				.textInputAutocapitalization(.never)
				.autocorrectionDisabled()
				.disabled(sending)
				.padding(.horizontal, 16)
				.padding(.vertical, 14)
				.settingsCard()
				.accessibilityLabel("Email addresses")
			SettingsGroup(note: role.description) {
				SettingsRow.trailing(label: "Role") {
					SegmentedChoice(label: "Role", options: roleOptions(canManageAdmins: canManageAdmins), value: role) { role = $0 }
				}
			}
			if !failed.isEmpty {
				FormAlert(text: failed.map { "\($0.email): \($0.reason)" }.joined(separator: "\n"))
			}
		}
	}

	private func send(_ emails: [String]) {
		guard !emails.isEmpty else { return }
		sending = true
		Task {
			let failures = await store.invite(emails, as: role.asAssignable)
			sending = false
			await sent()
			if failures.isEmpty {
				dismiss()
				return
			}
			// What went out is done; what is left is what to fix and send again.
			failed = failures
			text = failures.map(\.email).joined(separator: ", ")
		}
	}
}

/// One person, as the web's `MemberPage`: their role, the shared pods they're
/// in, when they joined, handing ownership on, and leaving or removing them.
@MainActor
struct MemberSettingsScreen: View {
	let memberId: String
	@Environment(Session.self) private var session
	@Environment(WorkspaceStore.self) private var store
	@Environment(\.dismiss) private var dismiss
	@State private var member: WorkspaceMember?
	@State private var missing = false
	@State private var roleFailure: String?
	@State private var confirming = false
	@State private var transferring = false

	var body: some View {
		if let member {
			page(member)
		} else if missing {
			SettingsPage { EmptyState(title: "No such person here", text: "They may have left the workspace, or been removed from it.").frame(minHeight: 320) }
		} else {
			SettingsPage { EmptyView() }.task { await load() }
		}
	}

	private func page(_ member: WorkspaceMember) -> some View {
		let may = store.permissions
		let isYou = member.user.id == store.user.id
		let isOwner = member.role == .owner
		// Your own role is not yours to change: demoting yourself takes away the
		// control you would need to undo it. The owner's changes only by handing ownership on.
		let mayManageThem = (may?.manageMembers ?? false) && !isYou && !isOwner && (member.role != .admin || (may?.manageAdmins ?? false))
		let mayLeave = isYou && !isOwner
		let sharedPods = store.pods.filter { $0.kind == .shared }
		let name = member.user.name
		return SettingsPage(
			title: name,
			description: member.user.email,
			hero: AnyView(PersonAvatar(name: name, email: member.user.email, image: member.user.image, size: 44))
		) {
			SettingsGroup(
				label: "Role",
				note: isYou && isOwner ? "\(member.role.description) To leave, transfer ownership to somebody else first." : member.role.description
			) {
				SettingsRow.trailing(label: "Role") {
					if mayManageThem {
						SegmentedChoice(label: "Role for \(name)", options: roleOptions(canManageAdmins: may?.manageAdmins ?? false), value: member.role) { setRole($0, of: member) }
					} else {
						SettingsValue(text: member.role.label)
					}
				}
				if let roleFailure {
					SettingsDivider()
					FormAlert(text: roleFailure).padding(.horizontal, 16).padding(.vertical, 12)
				}
			}
			if !sharedPods.isEmpty {
				SettingsGroup(
					label: "Pods",
					note: member.role.administers ? "Administrators are in every shared pod." : "They can talk to every bot in the pods they are in."
				) {
					DividedRows(data: sharedPods) { pod in
						PodMembershipRow(pod: pod, userId: member.user.id, name: name, canManage: (may?.manageMembers ?? false) && !member.role.administers)
					}
				}
			}
			SettingsGroup(label: "Details") {
				SettingsRow.trailing(label: "Joined") { SettingsValue(text: member.joinedAt.formatted(.dateTime.day().month(.abbreviated).year())) }
			}
			if (may?.transferOwnership ?? false) && !isYou {
				SettingsGroup(label: "Ownership", note: "The owner decides who administers the workspace, and is the only one who can hand it on.") {
					Button { transferring = true } label: { SettingsRow(label: "Make \(name) the owner", chevron: true) }
						.buttonStyle(SettingsRowPressStyle())
				}
			}
			if mayLeave || mayManageThem {
				SettingsDanger(
					label: isYou ? "Leave workspace" : "Remove from workspace",
					description: isYou ? "You lose access to every pod in the workspace." : "They lose access to every pod straight away.",
					action: isYou ? "Leave" : "Remove"
				) { confirming = true }
			}
		}
		.confirmDelete(
			isPresented: $transferring,
			title: "Make \(name) the owner?",
			description: "You stay on as an admin. Only \(name) can decide who else administers the workspace, or hand it back to you.",
			confirmLabel: "Transfer"
		) {
			try await store.transferOwnership(to: member)
			await load()
		}
		.confirmDelete(
			isPresented: $confirming,
			title: isYou ? "Leave this workspace?" : "Remove \(name)?",
			description: isYou
				? "You lose every pod in it, and your Personal pod and its conversations are deleted. Getting back in means somebody inviting you again."
				: "They lose this workspace and every pod in it, and their Personal pod and its conversations are deleted. Pods they made stay.",
			confirmLabel: isYou ? "Leave" : "Remove"
		) {
			if isYou {
				try await store.leaveWorkspace()
				await session.restore()
			} else {
				try await store.removeMember(member)
				// Back to People, so Back never returns to somebody no longer here.
				dismiss()
			}
		}
	}

	private func load() async {
		await store.refreshAccess()
		let members = try? await store.workspaceMembers()
		member = members?.first { $0.id == memberId }
		missing = members != nil && member == nil
	}

	private func setRole(_ role: WorkspaceRole, of member: WorkspaceMember) {
		Task {
			do {
				try await store.setRole(role.asAssignable, of: member)
				roleFailure = nil
				await load()
			} catch {
				roleFailure = error.localizedDescription
			}
		}
	}
}

/// One shared pod on a member's page: whether they're in it, which those who may can change.
@MainActor
private struct PodMembershipRow: View {
	let pod: Pod
	let userId: String
	let name: String
	let canManage: Bool
	@Environment(WorkspaceStore.self) private var store
	@State private var members: [PodMember]?
	@State private var placing = false
	@State private var failure: String?

	var body: some View {
		SettingsRow(
			label: pod.name,
			sub: failure ?? podSummary(bots: store.bots(in: pod).count, people: members?.count),
			leading: { PodInitial(kind: pod.kind, name: pod.name, color: pod.color?.rawValue, size: .row) },
			trailing: {
				WebToggle(label: "\(name) is in \(pod.name)", isOn: members?.contains { $0.userId == userId } ?? false) { place($0) }
					.disabled(!canManage || members == nil || placing)
			}
		)
		.task { members = try? await store.podMembers(pod.id) }
	}

	private func place(_ member: Bool) {
		placing = true
		Task {
			do {
				try await store.placeInPod(pod.id, userId: userId, member: member)
				members = try? await store.podMembers(pod.id)
				failure = nil
			} catch {
				failure = error.localizedDescription
			}
			placing = false
		}
	}
}
