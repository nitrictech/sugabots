import SwiftUI

/// The artifacts a message shows, each a card at the version written, as the
/// web's `ArtifactCards`: those its reply's calls wrote, under its tool line,
/// or, on a routine's posted result, those its run wrote. `onOpen` is given
/// the artifact as the message wrote it, to open at that version.
struct ArtifactCards: View {
	let parts: [MessagePart]
	let podId: String
	/// The bot that wrote the reply, whom each card names as its maker.
	let botName: String
	let onOpen: (WrittenArtifact) -> Void

	var body: some View {
		let written = WrittenArtifact.writtenIn(parts)
		if !written.isEmpty {
			VStack(alignment: .leading, spacing: 8) {
				ForEach(written) { artifact in
					ArtifactCard(podId: podId, artifact: artifact, botName: botName) { onOpen(artifact) }
				}
			}
			.padding(.bottom, 6)
		}
	}
}

/// An artifact among the messages: a header saying which bot made it, so a
/// page is never taken for the app's own screens, which expands to show it
/// in place, and opens it large.
@MainActor
private struct ArtifactCard: View {
	let podId: String
	let artifact: WrittenArtifact
	let botName: String
	let onOpen: () -> Void
	@Environment(WorkspaceStore.self) private var store
	@State private var content: Content = .loading
	@State private var expanded = false
	@State private var pageHeight = PageFrame.fitHeight.min
	@State private var pageExpanded = false

	private enum Content: Equatable {
		case loading
		case loaded(String)
		case failed
		case deleted
	}

	/// How much of a document a collapsed preview shows.
	private static let documentPreviewHeight: CGFloat = 168

	var body: some View {
		let kind = artifact.kind
		Group {
			if content == .deleted {
				HStack(spacing: 10) {
					Icon(kind.icon, size: 16)
						.foregroundStyle(Palette.subtleForeground)
						.frame(width: 32, height: 32)
						.background(Palette.chip, in: RoundedRectangle(cornerRadius: 8, style: .continuous))
					VStack(alignment: .leading, spacing: 1) {
						Text(artifact.title).font(Typeface.rubik(12.5, .medium)).foregroundStyle(Palette.mutedForeground).strikethrough().lineLimit(1)
						Text("\(kind.label) by \(botName), deleted").font(Typeface.rubik(12.5)).foregroundStyle(Palette.subtleForeground).lineLimit(1)
					}
					Spacer(minLength: 0)
				}
				.padding(.horizontal, 12)
				.padding(.vertical, 10)
				.overlay(RoundedRectangle(cornerRadius: 12, style: .continuous).strokeBorder(Palette.border, style: StrokeStyle(lineWidth: 1, dash: [4, 3])))
			} else {
				VStack(spacing: 0) {
					header(kind)
					if expanded, content != .failed {
						Rectangle().fill(Palette.border).frame(height: 1)
						inline
					}
				}
				.background(Palette.panel)
				.clipShape(RoundedRectangle(cornerRadius: 12, style: .continuous))
				.overlay(RoundedRectangle(cornerRadius: 12, style: .continuous).strokeBorder(Palette.border))
			}
		}
		.frame(maxWidth: expanded && artifact.kind == .html ? .infinity : 560, alignment: .leading)
		.accessibilityElement(children: .contain)
		.accessibilityLabel(artifact.title)
		.task(id: artifact.version) { await load() }
	}

	private func header(_ kind: ArtifactKind) -> some View {
		HStack(spacing: 10) {
			Icon(kind.icon, size: 15, strokeWidth: 2)
				.foregroundStyle(Palette.mutedForeground)
				.frame(width: 28, height: 28)
				.background(Palette.chip, in: RoundedRectangle(cornerRadius: 7, style: .continuous))
			VStack(alignment: .leading, spacing: 1) {
				Text(artifact.title).font(Typeface.rubik(12.5, .medium)).foregroundStyle(Palette.foreground).lineLimit(1)
				Text("\(kind.label) by \(botName)").font(Typeface.rubik(12.5)).foregroundStyle(Palette.mutedForeground).lineLimit(1)
			}
			.frame(maxWidth: .infinity, alignment: .leading)
			if content != .failed {
				Button { expanded.toggle() } label: {
					HStack(spacing: 6) {
						Icon(expanded ? .chevronUp : .chevronDown, size: 14)
						Text(expanded ? "Hide" : "Preview")
					}
				}
				.buttonStyle(CardButtonStyle(outlined: true))
				.accessibilityLabel("\(expanded ? "Hide" : "Preview") \(artifact.title)")
				.accessibilityValue(expanded ? "Expanded" : "Collapsed")
			}
			Button(action: onOpen) {
				HStack(spacing: 6) {
					Icon(.maximize2, size: 14)
					Text("Open")
				}
			}
			.buttonStyle(CardButtonStyle(outlined: false))
			.accessibilityLabel("Open \(artifact.title)")
		}
		.padding(.horizontal, 12)
		.padding(.vertical, 10)
	}

	@ViewBuilder private var inline: some View {
		switch content {
		case let .loaded(text):
			if artifact.kind == .html {
				let tall = pageHeight > PageFrame.fitHeight.max
				ArtifactFrame(html: text, title: artifact.title, podId: podId, artifactId: artifact.artifactId, version: artifact.version) { pageHeight = max(PageFrame.fitHeight.min, $0.rounded(.up)) }
					.frame(height: pageExpanded ? pageHeight : min(pageHeight, PageFrame.fitHeight.max))
					.overlay(alignment: .bottom) {
						if tall, !pageExpanded {
							LinearGradient(colors: [Palette.panel.opacity(0), Palette.panel], startPoint: .top, endPoint: .bottom)
								.frame(height: 80)
								.allowsHitTesting(false)
						}
					}
					.overlay(alignment: .bottom) {
						if tall {
							Button { pageExpanded.toggle() } label: {
								HStack(spacing: 6) {
									Icon(pageExpanded ? .chevronUp : .chevronDown, size: 15)
									Text(pageExpanded ? "Show less" : "Show all")
								}
								.font(Typeface.rubik(13, .semibold))
								.foregroundStyle(Palette.foreground)
								.padding(.horizontal, 14)
								.frame(height: 32)
								.background(Palette.panel, in: RoundedRectangle(cornerRadius: 8, style: .continuous))
								.overlay(RoundedRectangle(cornerRadius: 8, style: .continuous).strokeBorder(Palette.borderStrong))
							}
							.buttonStyle(.plain)
							.padding(.bottom, 12)
						}
					}
			} else {
				Button(action: onOpen) {
					MessageMarkdown(text: text)
						.frame(maxWidth: .infinity, alignment: .leading)
						.padding(.horizontal, 14)
						.padding(.vertical, 8)
						.frame(maxHeight: Self.documentPreviewHeight, alignment: .top)
						.clipped()
						.mask(LinearGradient(stops: [.init(color: .black, location: 0.6), .init(color: .clear, location: 1)], startPoint: .top, endPoint: .bottom))
				}
				.buttonStyle(.plain)
				.accessibilityLabel("Open \(artifact.title)")
			}
		default:
			Text("Loading…")
				.font(Typeface.rubik(12.5))
				.foregroundStyle(Palette.mutedForeground)
				.frame(maxWidth: .infinity, minHeight: 120)
		}
	}

	private func load() async {
		do {
			content = .loaded(try await store.artifact(artifact.artifactId, in: podId, version: artifact.version).content)
		} catch let failure as APIFailure where failure.status == 404 {
			content = .deleted
		} catch {
			content = .failed
		}
	}
}

/// The card's small buttons: Preview outlined on nothing, Open on a chip.
private struct CardButtonStyle: ButtonStyle {
	let outlined: Bool

	func makeBody(configuration: Configuration) -> some View {
		configuration.label
			.font(Typeface.rubik(13, outlined ? .medium : .semibold))
			.foregroundStyle(Palette.foreground)
			.padding(.horizontal, 14)
			.frame(height: 29)
			.background(
				configuration.isPressed ? Palette.hover : (outlined ? .clear : Palette.chip),
				in: RoundedRectangle(cornerRadius: 8, style: .continuous)
			)
			.overlay {
				if outlined { RoundedRectangle(cornerRadius: 8, style: .continuous).strokeBorder(Palette.borderStrong) }
			}
	}
}
