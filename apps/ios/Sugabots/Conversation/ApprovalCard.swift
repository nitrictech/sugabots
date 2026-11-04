import SwiftUI

/// A bot's request to use a tool, in its message, as the web's
/// `ToolApprovalCard` shows it on a phone: who wants what, the request folded
/// to a few lines, and Review, which opens it whole over the screen with
/// Deny and Allow.
@MainActor
struct ApprovalCard: View {
	let call: ToolCallPart
	let agent: AgentParticipant
	let podId: String
	/// What the person may decide in the call's thread.
	let capabilities: ThreadDetails.Capabilities?
	/// The pod's connections, by handle.
	let looks: [String: ConnectionLook]
	@State private var reviewing = false
	/// Whether the person answered here, before the answer arrives back on `call`.
	@State private var answered = false

	var body: some View {
		let step = ApprovalStep(call: call, agentName: agent.name, looks: looks)
		let answerable = call.awaitsApproval && mayAnswer && !answered
		VStack(alignment: .leading, spacing: 10) {
			StepHeading(step: step)
			FoldedRequest(input: call.input)
			VStack(alignment: .leading, spacing: 8) {
				status
				Button(answerable ? "Review" : "See request") { reviewing = true }
					.buttonStyle(WebButtonStyle(variant: answerable ? .primary : .secondary, size: .phone))
			}
		}
		.padding(.top, 10)
		.padding(.trailing, 12)
		.padding(.bottom, 12)
		.padding(.leading, 10)
		.frame(maxWidth: 460, alignment: .leading)
		.background(Palette.card, in: UnevenRoundedRectangle(topLeadingRadius: 6, bottomLeadingRadius: 20, bottomTrailingRadius: 20, topTrailingRadius: 20, style: .continuous))
		.accessibilityElement(children: .contain)
		.accessibilityLabel("Approval request: \(step.title)")
		.fullScreenCover(isPresented: $reviewing) {
			ReviewSheet(step: step, input: call.input, agent: agent) {
				if answerable {
					Answer(call: call, podId: podId, agentName: agent.name, actionLabel: step.action) {
						answered = true
						reviewing = false
					}
				} else {
					status
				}
			}
		}
	}

	/// Whether the person may answer the call, as the web's `mayAnswer`
	/// decides: a request to change the pod's sandbox is for those who manage
	/// it, any other for those who may approve the pod's tool calls.
	private var mayAnswer: Bool {
		answersSandbox
			? capabilities?.approveSandboxRequests ?? false
			: capabilities?.approveToolCalls ?? false
	}

	private var answersSandbox: Bool { call.approval?.deciders == .sandboxManagers }

	@ViewBuilder private var status: some View {
		if call.awaitsApproval && !mayAnswer {
			Text(answersSandbox
				? "Waiting for an admin of this pod to answer this."
				: "Waiting for someone with permission to answer this.")
				.font(Typeface.rubik(12))
				.foregroundStyle(Palette.mutedForeground)
		} else if call.approval?.status == .allowed {
			Outcome(icon: .check, text: "Allowed\(call.approval?.decidedByName.map { " by \($0)" } ?? "")")
		} else if call.approval?.status == .denied {
			Outcome(icon: .x, text: "Denied\(call.approval?.decidedByName.map { " by \($0)" } ?? ""). \(agent.name) won't go ahead.")
		}
	}
}

/// What a request is, in the words its card, its sheet and Approvals use, as
/// the web's `useApprovalApp` names them.
struct ApprovalStep {
	let action: String
	let who: String
	/// The connection the tool belongs to, by its label; empty for a tool of no connection.
	let whereName: String
	let look: ConnectionLook?
	let networkRequest: Bool

	/// `looks` is the pod's connections, by handle.
	init(call: ToolCallPart, agentName: String, looks: [String: ConnectionLook]) {
		let handle = ToolNames.handle(call.tool)
		let look = looks[handle]
		whereName = handle.isEmpty ? "" : ToolNames.connectionLabel(handle, name: look?.name)
		action = ToolNames.step(call.tool)
		networkRequest = call.tool == ToolNames.networkRequestTool
		who = networkRequest
			? "\(agentName) wants its sandbox to reach a new host"
			: "\(agentName) wants to use \(whereName.isEmpty ? "a tool" : whereName)"
		self.look = look
	}

	var title: String { whereName.isEmpty ? action : "\(action) in \(whereName)" }

	/// What the request's mark is named for: its connection, else the action.
	var appName: String { whereName.isEmpty ? action : whereName }
}

/// A request's app: its connection's mark, or a globe for reaching a host.
struct StepMark: View {
	let step: ApprovalStep
	/// 24 or 32 points.
	let small: Bool

	var body: some View {
		if step.networkRequest {
			Icon(.globe, size: small ? 16 : 14, strokeWidth: 2)
				.foregroundStyle(Palette.foreground)
				.frame(width: small ? 32 : 24, height: small ? 32 : 24)
				.background(Palette.borderStrong, in: RoundedRectangle(cornerRadius: small ? 8 : 7, style: .continuous))
		} else {
			ConnectionMark(presetId: step.look?.presetId, name: step.appName, size: small ? .sm : .md)
		}
	}
}

private struct StepHeading: View {
	let step: ApprovalStep

	var body: some View {
		HStack(alignment: .top, spacing: 10) {
			StepMark(step: step, small: false).padding(.top, 1)
			VStack(alignment: .leading, spacing: 2) {
				Text(step.who).font(Typeface.rubik(12)).foregroundStyle(Palette.mutedForeground)
				Text(step.action).font(Typeface.rubik(14, .medium)).foregroundStyle(Palette.foreground)
			}
		}
	}
}

private struct Outcome: View {
	let icon: Lucide
	let text: String

	var body: some View {
		HStack(alignment: .top, spacing: 6) {
			Icon(icon, size: 12, strokeWidth: 2.8).padding(.top, 3)
			Text(text)
		}
		.font(Typeface.rubik(12))
		.foregroundStyle(Palette.mutedForeground)
	}
}

/// A request folded to its first few lines, fading out, as a phone shows it on the card.
struct FoldedRequest: View {
	let input: JSONValue
	@State private var height: CGFloat = 0

	/// How tall a folded request stands.
	private static let foldedHeight: CGFloat = 66

	var body: some View {
		let foldable = height > Self.foldedHeight
		RequestValue(value: input, depth: 0)
			.fixedSize(horizontal: false, vertical: true)
			.background(GeometryReader { Color.clear.preference(key: HeightKey.self, value: $0.size.height) })
			.onPreferenceChange(HeightKey.self) { height = $0 }
			.frame(maxHeight: foldable ? Self.foldedHeight : nil, alignment: .top)
			.clipped()
			.mask {
				if foldable {
					LinearGradient(stops: [.init(color: .black, location: 0.55), .init(color: .clear, location: 1)], startPoint: .top, endPoint: .bottom)
				} else {
					Color.black
				}
			}
			.padding(.leading, 10)
			.overlay(alignment: .leading) { Rectangle().fill(Palette.borderDashed).frame(width: 2) }
	}

	private struct HeightKey: PreferenceKey {
		static let defaultValue: CGFloat = 0
		static func reduce(value: inout CGFloat, nextValue: () -> CGFloat) { value = max(value, nextValue()) }
	}
}

/// A request over the whole screen: the bot's face with the app's mark,
/// what it wants, every field, and the answer pinned at the foot.
private struct ReviewSheet<Footer: View>: View {
	let step: ApprovalStep
	let input: JSONValue
	let agent: AgentParticipant
	@ViewBuilder var footer: Footer
	@Environment(\.dismiss) private var dismiss

	var body: some View {
		VStack(spacing: 0) {
			HStack {
				GlassRoundButton(icon: .x, label: "Close", iconSize: 20) { dismiss() }
				Spacer()
			}
			.padding(.horizontal, 16)
			.pageTopPadding(14)
			ScrollView {
				VStack(alignment: .leading, spacing: 16) {
					VStack(spacing: 4) {
						BotFace(look: agent.look, size: 64)
							.overlay(alignment: .bottomTrailing) {
								StepMark(step: step, small: true)
									.padding(3)
									.background(Palette.panel, in: RoundedRectangle(cornerRadius: 10, style: .continuous))
									.offset(x: 8, y: 4)
							}
							.padding(.bottom, 10)
						Text(step.action)
							.font(Typeface.rubik(20, .bold))
							.foregroundStyle(Palette.foreground)
							.multilineTextAlignment(.center)
							.accessibilityAddTraits(.isHeader)
						Text(step.who)
							.font(Typeface.rubik(14))
							.foregroundStyle(Palette.mutedForeground)
							.multilineTextAlignment(.center)
					}
					.frame(maxWidth: .infinity)
					.padding(.bottom, 8)
					RequestValue(value: input, depth: 0)
				}
				.padding(16)
			}
			VStack(spacing: 0) {
				Rectangle().fill(Palette.borderSubtle).frame(height: 1)
				footer
					.padding(.horizontal, 16)
					.padding(.top, 12)
					.padding(.bottom, 16)
			}
		}
		.background(Palette.panel.ignoresSafeArea())
	}
}

/// Deny and Allow, side by side, which answer `call`, with what went wrong
/// under them; or, once its bot stopped waiting, that it no longer waits.
/// Once an answer is sent they stay disabled until `call` stops waiting.
@MainActor
struct Answer: View {
	let call: ToolCallPart
	let podId: String
	let agentName: String
	let actionLabel: String
	/// Runs once an answer is sent.
	var onDecided: () -> Void = {}
	@Environment(WorkspaceStore.self) private var store
	@State private var sending = false
	@State private var failure: String?

	var body: some View {
		if call.awaitsApproval {
			VStack(alignment: .leading, spacing: 6) {
				HStack(spacing: 8) {
					Button("Deny") { decide(.deny) }
						.buttonStyle(WebButtonStyle(variant: .muted, size: .phone))
						.accessibilityLabel("Deny: \(actionLabel)")
					Button("Allow") { decide(.allowOnce) }
						.buttonStyle(WebButtonStyle(size: .phone))
						.accessibilityLabel("Allow: \(actionLabel)")
				}
				.disabled(sending)
				if let failure {
					Text(failure).font(Typeface.rubik(12)).foregroundStyle(Palette.destructiveText)
				}
			}
		} else {
			Text("No longer waiting: \(agentName) stopped before it was answered.")
				.font(Typeface.rubik(13))
				.foregroundStyle(Palette.mutedForeground)
		}
	}

	private func decide(_ decision: WorkspaceStore.Decision) {
		sending = true
		failure = nil
		Task {
			do {
				try await store.decide(decision, toolCallId: call.id, podId: podId)
				onDecided()
			} catch {
				failure = error.localizedDescription
				sending = false
			}
		}
	}
}

/// What a tool was asked to do, laid out for a person to read: fields as
/// labelled values, lists of like records as tables, the rest as code.
struct RequestValue: View {
	let value: JSONValue
	let depth: Int

	/// How deep structure is laid out before it shows as code.
	private static let maxDepth = 3

	var body: some View {
		switch value {
		case let .object(fields) where !fields.isEmpty && depth < Self.maxDepth:
			FieldList(fields: fields.sorted { $0.key < $1.key }, depth: depth)
		case let .array(entries) where Self.isRecordList(entries) && depth < Self.maxDepth:
			EntryList(entries: entries, depth: depth)
		case .array where Self.isPlainList(value):
			PlainValue(value: value)
		case .object, .array:
			Text(value.prettyPrinted)
				.font(Typeface.mono(11))
				.foregroundStyle(Palette.foreground)
				.padding(.horizontal, 10)
				.padding(.vertical, 8)
				.frame(maxWidth: .infinity, alignment: .leading)
				.background(Palette.list, in: RoundedRectangle(cornerRadius: 6, style: .continuous))
		default:
			PlainValue(value: value)
		}
	}

	static func isPlainList(_ value: JSONValue) -> Bool {
		guard case let .array(items) = value else { return false }
		return items.allSatisfy { if case .object = $0 { false } else if case .array = $0 { false } else { true } }
	}

	static func isRecordList(_ entries: [JSONValue]) -> Bool {
		!entries.isEmpty && !isPlainList(.array(entries))
	}

	static func hasStructure(_ value: JSONValue) -> Bool {
		if case let .array(items) = value { return isRecordList(items) }
		if case let .object(fields) = value { return !fields.isEmpty }
		return false
	}
}

private struct FieldList: View {
	let fields: [(key: String, value: JSONValue)]
	let depth: Int

	var body: some View {
		VStack(alignment: .leading, spacing: 12) {
			ForEach(fields, id: \.key) { field in
				VStack(alignment: .leading, spacing: 2) {
					Text(ToolNames.words(fromKey: field.key))
						.font(Typeface.rubik(14))
						.foregroundStyle(Palette.mutedForeground)
					if RequestValue.hasStructure(field.value) {
						RequestValue(value: field.value, depth: depth + 1)
							.padding(.leading, 12)
							.overlay(alignment: .leading) { Rectangle().fill(Palette.borderSubtle).frame(width: 1) }
							.padding(.leading, 4)
							.padding(.top, 4)
					} else {
						PlainValue(value: field.value)
					}
				}
			}
		}
	}
}

private struct EntryList: View {
	let entries: [JSONValue]
	let depth: Int
	@State private var showAll = false

	/// How many entries show before Show all.
	private static let shown = 10

	var body: some View {
		VStack(alignment: .leading, spacing: 8) {
			ForEach(Array((showAll ? entries : Array(entries.prefix(Self.shown))).enumerated()), id: \.offset) { index, entry in
				HStack(alignment: .firstTextBaseline, spacing: 10) {
					Text("\(index + 1)")
						.font(Typeface.mono(11))
						.foregroundStyle(Palette.mutedForeground)
						.frame(width: 20, alignment: .trailing)
					if Self.isSmallRecord(entry) {
						SmallRecord(fields: entry.fields.sorted { $0.key < $1.key })
					} else {
						RequestValue(value: entry, depth: depth + 1)
					}
				}
			}
			if entries.count > Self.shown {
				Button(showAll ? "Show fewer" : "Show all \(entries.count)") { showAll.toggle() }
					.font(Typeface.rubik(12, .semibold))
					.foregroundStyle(Palette.foreground)
					.padding(.leading, 28)
			}
		}
	}

	/// A record of a few plain fields, written on one line.
	static func isSmallRecord(_ value: JSONValue) -> Bool {
		guard case let .object(fields) = value, !fields.isEmpty, fields.count <= 4 else { return false }
		return fields.values.allSatisfy { !RequestValue.hasStructure($0) }
	}
}

private struct SmallRecord: View {
	let fields: [(key: String, value: JSONValue)]

	var body: some View {
		fields.enumerated().reduce(Text("")) { text, element in
			let (index, field) = element
			let label = Text((index > 0 ? ", " : "") + ToolNames.words(fromKey: field.key) + " ").foregroundStyle(Palette.mutedForeground)
			return text + label + Text(PlainValue.words(field.value)).foregroundStyle(Palette.foreground)
		}
		.font(Typeface.rubik(14))
	}
}

/// A plain value: text as written, a number, Yes or No, or Empty.
struct PlainValue: View {
	let value: JSONValue

	var body: some View {
		let quiet = PlainValue.isQuiet(value)
		Text(Self.words(value))
			.font(Typeface.rubik(14))
			.foregroundStyle(quiet ? Palette.mutedForeground : Palette.foreground)
			.monospacedDigit()
			.textSelection(.enabled)
	}

	static func isQuiet(_ value: JSONValue) -> Bool {
		switch value {
		case .null, .bool: true
		case let .string(text): text.isEmpty
		case let .array(items): items.isEmpty
		case .object: true
		case .number: false
		}
	}

	static func words(_ value: JSONValue) -> String {
		switch value {
		case let .array(items) where RequestValue.isPlainList(value):
			return items.isEmpty ? "None" : items.map { words($0) }.joined(separator: ", ")
		case .null: return "Empty"
		case let .string(text): return text.isEmpty ? "Empty" : text
		case let .bool(flag): return flag ? "Yes" : "No"
		case .number: return value.prettyPrinted
		default: return "None"
		}
	}
}
