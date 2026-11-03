import SwiftUI

/// Approvals, as the web's `Approvals` on a phone: what waits on the person,
/// each a card with the request folded and Deny and Allow, then what was
/// resolved, newest first.
@MainActor
struct ApprovalsScreen: View {
	@Environment(WorkspaceStore.self) private var store
	@State private var showAll = false

	/// How many resolved requests show before Show older.
	private static let answeredShown = 10

	var body: some View {
		let waiting = store.approvals.waiting.map(ApprovalEntry.init)
		let answered = store.approvals.answered.map(ApprovalEntry.init)
		let shown = showAll ? answered : Array(answered.prefix(Self.answeredShown))
		VStack(spacing: 0) {
			TabPageHeader(title: "Approvals") { EmptyView() }
			ScrollView {
				VStack(alignment: .leading, spacing: 12) {
					if store.approvalsFailed {
						Text("Approvals could not be loaded.").font(Typeface.rubik(15)).foregroundStyle(Palette.mutedForeground).padding(.horizontal, 4)
					}
					if store.approvalsLoaded {
						if waiting.isEmpty {
							NothingWaiting().padding(.bottom, 12)
						} else {
							SectionLabel(text: "Waiting on you")
							VStack(spacing: 8) {
								ForEach(waiting) { WaitingCard(request: $0) }
							}
							.padding(.bottom, 20)
						}
						if !answered.isEmpty {
							SectionLabel(text: "Resolved")
							VStack(spacing: 0) {
								ForEach(shown) { ResolvedRow(request: $0) }
							}
							if answered.count > shown.count {
								Button("Show older") { showAll = true }
									.font(Typeface.rubik(15, .medium))
									.foregroundStyle(Palette.foreground)
									.frame(maxWidth: .infinity)
									.padding(.vertical, 8)
							}
						}
					}
				}
				.padding(.horizontal, 16)
				.padding(.top, 6)
				.padding(.bottom, 48)
			}
			.refreshable { await store.refreshAttention() }
		}
		.background(Palette.background.ignoresSafeArea())
	}
}

private struct SectionLabel: View {
	let text: String

	var body: some View {
		Text(text)
			.font(Typeface.rubik(13, .medium))
			.foregroundStyle(Palette.mutedForeground)
			.padding(.horizontal, 2)
			.padding(.bottom, -2)
			.accessibilityAddTraits(.isHeader)
	}
}

/// Approvals with nothing waiting: a card saying so, and what Approvals is for.
private struct NothingWaiting: View {
	var body: some View {
		HStack(spacing: 14) {
			Icon(.shieldCheck, size: 20, strokeWidth: 1.75)
				.foregroundStyle(Palette.mutedForeground)
				.frame(width: 40, height: 40)
				.background(Palette.chip, in: RoundedRectangle(cornerRadius: 10, style: .continuous))
			VStack(alignment: .leading, spacing: 2) {
				Text("Nothing waiting on you").font(Typeface.rubik(15, .medium)).foregroundStyle(Palette.foreground)
				Text("Bots ask here before they do anything you need to allow.").font(Typeface.rubik(14)).lineSpacing(4).foregroundStyle(Palette.mutedForeground)
			}
			Spacer(minLength: 0)
		}
		.padding(.horizontal, 16)
		.frame(minHeight: 98)
		.background(Palette.card, in: RoundedRectangle(cornerRadius: 14, style: .continuous))
		.overlay(RoundedRectangle(cornerRadius: 14, style: .continuous).strokeBorder(Palette.border))
	}
}

/// Where and when a request was asked: `in Acme at 6:12`.
private func askedWhereAndWhen(_ request: ApprovalEntry, in pod: Pod?) -> String {
	[pod.map { "in \($0.name)" }, "at \(Times.list(request.call.startedAt))"].compactMap { $0 }.joined(separator: " ")
}

private extension AnsweredApproval.Answer {
	/// `Allowed` or `Denied`.
	var verdict: String { status == .allowed ? "Allowed" : "Denied" }
}

/// A request waiting on the person: who asked for what, where and when, which opens it; the request folded; Deny and Allow.
@MainActor
private struct WaitingCard: View {
	let request: ApprovalEntry
	@Environment(WorkspaceStore.self) private var store

	var body: some View {
		let action = ToolNames.step(request.call.tool)
		let asked = askedWhereAndWhen(request, in: store.pod(id: request.podId))
		VStack(alignment: .leading, spacing: 12) {
			NavigationLink(value: Route.approval(callId: request.call.id)) {
				HStack(spacing: 12) {
					BotFace(look: request.agent.look, size: 24)
					VStack(alignment: .leading, spacing: 2) {
						Text(action).font(Typeface.rubik(17, .medium)).foregroundStyle(Palette.foreground).multilineTextAlignment(.leading)
						Text("\(request.agent.name) asked \(asked)").font(Typeface.rubik(13)).foregroundStyle(Palette.subtleForeground)
					}
					.frame(maxWidth: .infinity, alignment: .leading)
					Icon(.chevronRight, size: 16, strokeWidth: 2).foregroundStyle(Palette.disabledForeground)
				}
				.contentShape(Rectangle())
			}
			.buttonStyle(.plain)
			FoldedRequest(input: request.call.input)
			Answer(call: request.call, podId: request.podId, agentName: request.agent.name, actionLabel: action)
		}
		.padding(14)
		.background(Palette.card, in: RoundedRectangle(cornerRadius: 14, style: .continuous))
		.overlay(RoundedRectangle(cornerRadius: 14, style: .continuous).strokeBorder(Palette.border))
		.accessibilityElement(children: .contain)
		.accessibilityLabel("\(request.agent.name): \(action)")
	}
}

/// A resolved request on two lines, what it would have done over which bot, with how it was answered and when.
private struct ResolvedRow: View {
	let request: ApprovalEntry

	var body: some View {
		let action = ToolNames.step(request.call.tool)
		NavigationLink(value: Route.approval(callId: request.call.id)) {
			HStack(spacing: 12) {
				BotFace(look: request.agent.look, size: 20)
				VStack(alignment: .leading, spacing: 2) {
					Text(action).font(Typeface.rubik(15)).foregroundStyle(Palette.foreground).lineLimit(1)
					Text(request.agent.name).font(Typeface.rubik(13)).foregroundStyle(Palette.subtleForeground).lineLimit(1)
				}
				.frame(maxWidth: .infinity, alignment: .leading)
				Text(request.answer?.verdict ?? "")
					.font(Typeface.rubik(12))
					.foregroundStyle(Palette.mutedForeground)
				Text(request.answer.map { Times.age($0.decidedAt) } ?? "")
					.font(Typeface.rubik(12))
					.foregroundStyle(Palette.subtleForeground)
					.frame(width: 64, alignment: .trailing)
			}
			.padding(.horizontal, 4)
			.frame(minHeight: 56)
			.contentShape(Rectangle())
		}
		.buttonStyle(PressableRowStyle(pressed: Palette.rowSelected, cornerRadius: 8))
	}
}

/// One request on its own page, as the web's `ApprovalPage` on a phone: the
/// app's mark and the action over who asked, where and when, every field,
/// then Deny and Allow, or how it was answered, and Open conversation.
@MainActor
struct ApprovalPage: View {
	let callId: String
	@Environment(WorkspaceStore.self) private var store
	@State private var looks: [String: ConnectionLook] = [:]

	var body: some View {
		let waiting = store.approvals.waiting.first { $0.call.id == callId }.map(ApprovalEntry.init)
		let request = waiting ?? store.approvals.answered.first { $0.call.id == callId }.map(ApprovalEntry.init)
		ScrollView {
			VStack(alignment: .leading, spacing: 20) {
				HStack { PhoneBackButton(label: "Back to Approvals"); Spacer() }
				if let request {
					detail(request, waiting: waiting != nil)
				} else if store.approvalsLoaded {
					VStack(spacing: 6) {
						Text("This request is no longer here").font(Typeface.rubik(15, .medium)).foregroundStyle(Palette.foreground)
						Text("It may have been answered a while ago, or its chat removed.").font(Typeface.rubik(14)).foregroundStyle(Palette.mutedForeground)
					}
					.multilineTextAlignment(.center)
					.frame(maxWidth: .infinity)
					.padding(.top, 80)
				}
			}
			.padding(.horizontal, 16)
			.pageTopPadding()
			.padding(.bottom, 32)
		}
		.background(Palette.background.ignoresSafeArea())
		.task(id: request?.podId) {
			if let podId = request?.podId { looks = await store.connectionLooks(podId: podId) }
		}
	}

	@ViewBuilder private func detail(_ request: ApprovalEntry, waiting: Bool) -> some View {
		let step = ApprovalStep(call: request.call, agentName: request.agent.name, looks: looks)
		let pod = store.pod(id: request.podId)
		let asked = askedWhereAndWhen(request, in: pod)
		HStack(spacing: 12) {
			ConnectionMark(presetId: step.look?.presetId, name: step.appName, size: .sm)
			VStack(alignment: .leading, spacing: 4) {
				Text(step.action).font(Typeface.rubik(22, .semibold)).tracking(-0.22).foregroundStyle(Palette.foreground)
				Text("\(request.agent.name) wants to use \(step.appName) · \(asked)").font(Typeface.rubik(14)).foregroundStyle(Palette.mutedForeground)
			}
		}
		let fields = request.call.input.fields.sorted { $0.key < $1.key }
		if !fields.isEmpty {
			VStack(spacing: 0) {
				DividedRows(data: fields, id: \.key) { field in
					VStack(alignment: .leading, spacing: 4) {
						Text(ToolNames.words(fromKey: field.key)).font(Typeface.rubik(14)).foregroundStyle(Palette.subtleForeground)
						RequestValue(value: field.value, depth: 1)
					}
					.frame(maxWidth: .infinity, alignment: .leading)
					.padding(.horizontal, 14)
					.padding(.vertical, 12)
				}
			}
			.clipShape(RoundedRectangle(cornerRadius: 12, style: .continuous))
			.overlay(RoundedRectangle(cornerRadius: 12, style: .continuous).strokeBorder(Palette.border))
		}
		VStack(spacing: 16) {
			if let answer = request.answer, !waiting {
				HStack(spacing: 6) {
					Icon(answer.status == .allowed ? .check : .x, size: 13, strokeWidth: 2.8)
					Text("\(answer.verdict)\(answer.decidedByName.map { " by \($0)" } ?? "") at \(Times.list(answer.decidedAt))")
				}
				.font(Typeface.rubik(13))
				.foregroundStyle(Palette.mutedForeground)
				.frame(maxWidth: .infinity, alignment: .leading)
			} else {
				Answer(call: request.call, podId: request.podId, agentName: request.agent.name, actionLabel: step.action)
			}
			if pod != nil, let conversationId = request.conversationId {
				NavigationLink("Open conversation", value: Route.conversation(threadId: conversationId, title: ""))
					.font(Typeface.rubik(15, .medium))
					.foregroundStyle(Palette.foreground)
					.padding(.vertical, 8)
			}
		}
		.padding(.top, 4)
	}
}
