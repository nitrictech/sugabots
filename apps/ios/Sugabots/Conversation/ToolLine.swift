import SwiftUI

/// A bot's tool calls in a message, as the web's `ToolLine`: one line saying
/// what it used and for how long, which unfolds into each step, and each
/// step into what it was given and gave back.
struct ToolLine: View {
	let parts: [MessagePart]
	var looks: [String: ConnectionLook] = [:]
	let fileNames: [String: String]
	@State private var open = false

	var body: some View {
		let runs = ToolSteps.runs(of: parts)
		let calls = runs.flatMap(\.calls)
		if !calls.isEmpty {
			VStack(alignment: .leading, spacing: 0) {
				Button { open.toggle() } label: {
					HStack(spacing: 6) {
						Text(ToolSteps.lineText(calls, looks: looks)).lineLimit(1)
						Icon(.chevronRight, size: 10, strokeWidth: 3)
							.foregroundStyle(Palette.subtleForeground)
							.rotationEffect(.degrees(open ? 90 : 0))
					}
					.font(Typeface.rubik(14, .medium))
					.foregroundStyle(Palette.mutedForeground)
					.padding(.bottom, 6)
					.contentShape(Rectangle())
				}
				.buttonStyle(.plain)
				.accessibilityValue(open ? "Expanded" : "Collapsed")
				if open {
					VStack(alignment: .leading, spacing: 0) {
						ForEach(Array(runs.enumerated()), id: \.offset) { index, run in
							if let narration = run.narration {
								Text(narration)
									.font(Typeface.rubik(13))
									.foregroundStyle(Palette.mutedForeground)
									.padding(.top, index > 0 ? 8 : 0)
									.padding(.bottom, 2)
							}
							ForEach(run.calls) { call in
								ToolCallRow(call: call, look: looks[ToolNames.handle(call.tool)], fileNames: fileNames)
							}
						}
					}
					.padding(.vertical, 2)
					.padding(.leading, 14)
					.overlay(alignment: .leading) { Rectangle().fill(Palette.hover).frame(width: 1.5) }
					.padding(.bottom, 8)
				}
			}
		}
	}
}

private struct ToolCallRow: View {
	let call: ToolCallPart
	let look: ConnectionLook?
	let fileNames: [String: String]
	@State private var open = false

	var body: some View {
		let step = ToolSteps.describe(call, fileNames: fileNames)
		let note = ToolSteps.note(of: call)
		VStack(alignment: .leading, spacing: 0) {
			Button { open.toggle() } label: {
				HStack(spacing: 8) {
					if ToolNames.handle(call.tool).isEmpty {
						Icon(.wrench, size: 10, strokeWidth: 2.4)
							.foregroundStyle(Palette.softForeground)
							.frame(width: 16, height: 16)
							.background(Palette.borderStrong, in: RoundedRectangle(cornerRadius: 2))
					} else {
						ConnectionMark(presetId: look?.presetId, name: ToolSteps.appOf(call, look: look), size: .xs)
					}
					HStack(alignment: .firstTextBaseline, spacing: 6) {
						Text(step.action).font(Typeface.rubik(13, .medium)).foregroundStyle(Palette.softForeground).fixedSize()
						if let subject = step.subject {
							Text(subject.text)
								.font(subject.asCode ? Typeface.mono(12.5) : Typeface.rubik(13))
								.foregroundStyle(subject.asCode ? Palette.subtleForeground : Palette.mutedForeground)
								.lineLimit(1)
						}
					}
					if let note {
						Text(note.text)
							.font(Typeface.rubik(12))
							.foregroundStyle(note.failed ? Palette.destructiveText : Palette.subtleForeground)
							.lineLimit(1)
							.layoutPriority(-1)
					}
					Spacer(minLength: 8)
					if call.finishedAt != nil {
						Text(ToolSteps.formatDuration(ToolSteps.duration(of: call)))
							.font(Typeface.mono(11.5))
							.foregroundStyle(Palette.subtleForeground)
					}
					Icon(.chevronRight, size: 10, strokeWidth: 3)
						.foregroundStyle(Palette.subtleForeground)
						.rotationEffect(.degrees(open ? 90 : 0))
				}
				.padding(.vertical, 3)
				.contentShape(Rectangle())
			}
			.buttonStyle(.plain)
			if open { CallDetails(call: call, details: ToolSteps.details(of: call)) }
		}
	}
}

private struct CallDetails: View {
	let call: ToolCallPart
	let details: ToolSteps.Details

	var body: some View {
		VStack(alignment: .leading, spacing: 8) {
			HStack(alignment: .firstTextBaseline, spacing: 6) {
				Text("Tool").font(Typeface.rubik(11.5, .medium)).foregroundStyle(Palette.subtleForeground)
				Text(call.tool).font(Typeface.mono(11.5)).foregroundStyle(Palette.softForeground)
			}
			if let input = details.input {
				block("Input", input, other: details.otherArguments)
			}
			if let error = call.error {
				block("Error", .string(error), failed: true)
			} else if let output = details.output {
				block("Output", output, footnote: details.outputCut)
			}
			if details.input == nil, details.output == nil, call.error == nil {
				Text(call.status == .running ? "Still running" : "Nothing to show")
					.font(Typeface.rubik(12))
					.foregroundStyle(Palette.subtleForeground)
			}
		}
		.padding(.top, 4)
		.padding(.bottom, 8)
		.padding(.leading, 24)
	}

	private func block(_ label: String, _ value: JSONValue, other: JSONValue? = nil, failed: Bool = false, footnote: String? = nil) -> some View {
		VStack(alignment: .leading, spacing: 4) {
			Text(label).font(Typeface.rubik(11.5, .medium)).foregroundStyle(Palette.subtleForeground)
			ToolCallValue(value: value, failed: failed)
			if let other { ToolCallValue(value: other, failed: false) }
			if let footnote {
				Text(footnote).font(Typeface.rubik(11.5)).foregroundStyle(Palette.subtleForeground)
			}
		}
	}
}

/// A value a tool was given or gave back, as code on a panel.
struct ToolCallValue: View {
	let value: JSONValue
	let failed: Bool

	var body: some View {
		ScrollView(.horizontal, showsIndicators: false) {
			Text(value.prettyPrinted)
				.font(Typeface.mono(11.5))
				.foregroundStyle(failed ? Palette.destructiveText : Palette.softForeground)
				.textSelection(.enabled)
				.padding(.horizontal, 10)
				.padding(.vertical, 8)
		}
		.frame(maxWidth: .infinity, maxHeight: 240, alignment: .leading)
		.background(Palette.list, in: RoundedRectangle(cornerRadius: 6, style: .continuous))
	}
}
