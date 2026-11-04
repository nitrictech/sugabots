import PhotosUI
import SwiftUI
import UniformTypeIdentifiers

/// A file being attached to a draft: uploading, ready, or failed.
@MainActor
@Observable
final class ComposerAttachment: Identifiable {
	enum Upload {
		case uploading
		case ready(FilePart)
		case failed(String, retryable: Bool)
	}

	let id = UUID()
	let name: String
	let contentType: String
	let data: Data
	var upload = Upload.uploading

	init(name: String, contentType: String, data: Data) {
		self.name = name
		self.contentType = contentType
		self.data = data
	}

	var file: FilePart? {
		if case let .ready(file) = upload { file } else { nil }
	}
}

/// The files attached to a draft, each uploaded as soon as it is added, as the web's `useComposerAttachments`.
@MainActor
@Observable
final class ComposerAttachments {
	static let maximum = Limits.maxAttachmentsPerMessage
	/// Why a file over `MAX_ATTACHMENT_BYTES` is never uploaded, as the web says it.
	static let tooLargeReason = "Too large. \(Limits.maxAttachmentMegabytes) MB at most."

	private(set) var items: [ComposerAttachment] = []
	/// How many files were left out for going past the most a message holds.
	private(set) var leftOut = 0
	private let conversationId: String
	private let client: APIClient

	init(conversationId: String, client: APIClient) {
		self.conversationId = conversationId
		self.client = client
	}

	var isFull: Bool { items.count >= Self.maximum }
	var uploading: Int { items.filter { if case .uploading = $0.upload { true } else { false } }.count }
	var failed: Int { items.filter { if case .failed = $0.upload { true } else { false } }.count }
	var ready: Bool { uploading == 0 && failed == 0 }

	func attach(_ files: [(name: String, contentType: String, data: Data)]) {
		let room = Self.maximum - items.count
		leftOut = max(files.count - room, 0)
		for file in files.prefix(max(room, 0)) {
			let attachment = ComposerAttachment(name: file.name, contentType: file.contentType, data: file.data)
			items.append(attachment)
			if file.data.count > Limits.maxAttachmentBytes {
				attachment.upload = .failed(Self.tooLargeReason, retryable: false)
			} else {
				upload(attachment)
			}
		}
	}

	func remove(_ attachment: ComposerAttachment) {
		items.removeAll { $0.id == attachment.id }
		leftOut = 0
		if let file = attachment.file {
			Task { try? await client.chats.removeFile(conversationId: conversationId, fileId: file.id) }
		}
	}

	func retry(_ attachment: ComposerAttachment) {
		attachment.upload = .uploading
		upload(attachment)
	}

	/// The files to send, taken out of the draft; put back if sending fails.
	func takeForSending() -> [FilePart] {
		let files = items.compactMap(\.file)
		items = []
		leftOut = 0
		return files
	}

	private func upload(_ attachment: ComposerAttachment) {
		Task {
			do {
				let uploaded = try await client.chats.uploadFile(
					conversationId: conversationId, name: attachment.name, type: attachment.contentType, data: attachment.data
				)
				attachment.upload = .ready(FilePart(id: uploaded.id, name: uploaded.name, contentType: uploaded.contentType, size: uploaded.size))
			} catch let failure as APIFailure {
				attachment.upload = .failed(failure.status == 413 ? "Too big to attach" : failure.message, retryable: failure.status >= 500)
			} catch {
				attachment.upload = .failed("Couldn't upload", retryable: true)
			}
		}
	}
}

/// The message box at a conversation's foot, as the web's `ChatComposer` on
/// a phone: a pill holding + to attach, the draft, and a round Send; over
/// them what it replies to and the files attached; over the pill, people and
/// bots to mention while an `@` is typed.
@MainActor
struct Composer: View {
	let label: String
	/// What the empty draft says, when it isn't the label.
	var placeholder: String?
	@Binding var text: String
	/// Whom an `@` can name: people and bots, and where it would notify somebody, everyone.
	let mentionable: [MentionTarget]
	var replyingTo: MessageReplyTo?
	var cancelReply: () -> Void = {}
	let attachments: ComposerAttachments?
	var sending = false
	var error: String?
	var needsText = false
	let submit: () -> Void
	/// Whether the field has the keyboard. Plain state, not `FocusState`: the
	/// field is UIKit's, so no SwiftUI view is focused on it, and SwiftUI puts a
	/// `FocusState` nothing is focused on back to false, taking the keyboard away
	/// as soon as it comes up.
	@Binding var focused: Bool
	@State private var picking = false
	@State private var importing = false
	@State private var photos: [PhotosPickerItem] = []
	@State private var dismissedMentionAt: Int?

	var body: some View {
		let shortcode = shortcodeBeingTyped
		let mention = shortcode == nil ? mentionBeingTyped : nil
		VStack(alignment: .leading, spacing: 0) {
			ZStack(alignment: .bottomLeading) {
				pill
				if let shortcode, focused {
					EmojiSuggestionList(matches: shortcode.matches) { emoji in
						text = String(text[..<shortcode.start]) + emoji.emoji + " "
						EmojiShortcodes.remember(emoji)
					}
					.padding(.leading, 6)
					.offset(y: -(pillHeight + 6))
				} else if let mention, !mention.matches.isEmpty, focused {
					SuggestionList(matches: mention.matches) { choose($0, replacing: mention) }
						.padding(.leading, 6)
						.offset(y: -(pillHeight + 6))
				}
			}
			if let error {
				Text(error)
					.font(Typeface.rubik(14))
					.foregroundStyle(Palette.destructiveText)
					.padding(.top, 6)
					.padding(.leading, 12)
			}
		}
		.photosPicker(isPresented: $picking, selection: $photos, maxSelectionCount: ComposerAttachments.maximum, matching: .any(of: [.images, .videos]))
		.fileImporter(isPresented: $importing, allowedContentTypes: [.item], allowsMultipleSelection: true) { result in
			guard case let .success(urls) = result else { return }
			attachments?.attach(urls.compactMap(Self.read))
		}
		.onChange(of: photos) { _, items in
			guard !items.isEmpty else { return }
			Task {
				var files: [(name: String, contentType: String, data: Data)] = []
				for (index, item) in items.enumerated() {
					guard let data = try? await item.loadTransferable(type: Data.self) else { continue }
					let type = item.supportedContentTypes.first ?? .jpeg
					let ext = type.preferredFilenameExtension ?? "jpg"
					files.append(("Photo \(index + 1).\(ext)", type.preferredMIMEType ?? "image/jpeg", data))
				}
				attachments?.attach(files)
				photos = []
			}
		}
	}

	@State private var pillHeight: CGFloat = 46

	private var pill: some View {
		VStack(spacing: 0) {
			if let replyingTo {
				ReplyingToStrip(replyTo: replyingTo, cancel: cancelReply)
			}
			if let attachments, !attachments.items.isEmpty {
				AttachmentTray(attachments: attachments)
			}
			if let attachments, attachments.leftOut > 0 {
				Text("\(Names.count(attachments.leftOut, "file was", "files were")) left out. \(ComposerAttachments.maximum) is the most for one message.")
					.font(Typeface.rubik(12))
					.foregroundStyle(Palette.subtleForeground)
					.padding(.horizontal, 12)
					.padding(.vertical, 6)
					.frame(maxWidth: .infinity, alignment: .leading)
			}
			HStack(alignment: .bottom, spacing: 4) {
				Menu {
					Button { picking = true } label: { Label("Photo Library", systemImage: "photo.on.rectangle") }
					Button { importing = true } label: { Label("Choose Files", systemImage: "folder") }
				} label: {
					Icon(.plus, size: 20, strokeWidth: 2)
						.foregroundStyle(Palette.mutedForeground)
						.frame(width: 36, height: 36)
						.contentShape(Circle())
				}
				.disabled(attachments == nil || attachments?.isFull == true)
				.opacity(attachments == nil || attachments?.isFull == true ? 0.4 : 1)
				.accessibilityLabel("Attach files")
				MentionEditor(text: $text, isFocused: Binding(get: { focused }, set: { focused = $0 }), mentionable: mentionable)
					.overlay(alignment: .topLeading) {
						if text.isEmpty {
							Text(placeholder ?? label)
								.font(Typeface.rubik(16))
								.foregroundStyle(Palette.subtleForeground)
								.lineLimit(1)
								.padding(.leading, 4)
								.padding(.top, 8)
								.allowsHitTesting(false)
						}
					}
					.frame(maxWidth: .infinity)
					.accessibilityLabel(label)
					.onChange(of: text) { _, typed in
						dismissedMentionAt = nil
						completeShortcode(typed)
					}
				Button(action: submit) {
					Icon(.arrowUp, size: 18, strokeWidth: 2.25)
						.foregroundStyle(canSend ? Palette.primaryForeground : Palette.disabledForeground)
						.frame(width: 36, height: 36)
						.background(canSend ? Palette.primary : Palette.chipStrong, in: Circle())
				}
				.buttonStyle(.plain)
				.disabled(!canSend)
				.accessibilityLabel("Send message")
			}
		}
		.padding(4)
		.background(Palette.panel, in: RoundedRectangle(cornerRadius: 23, style: .continuous))
		.overlay(RoundedRectangle(cornerRadius: 23, style: .continuous).strokeBorder(Palette.borderStrong))
		.background(GeometryReader { geometry in
			Color.clear.onAppear { pillHeight = geometry.size.height }
				.onChange(of: geometry.size.height) { _, height in pillHeight = height }
		})
	}

	private var canSend: Bool {
		let hasText = !text.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty
		let hasFiles = !(attachments?.items.isEmpty ?? true)
		guard !sending, attachments?.ready ?? true else { return false }
		return needsText ? hasText : hasText || hasFiles
	}

	/// The `@` being typed at the draft's end, and who it could mention.
	private var mentionBeingTyped: (start: String.Index, query: String, matches: [MentionTarget])? {
		guard let at = text.lastIndex(of: "@") else { return nil }
		let offset = text.distance(from: text.startIndex, to: at)
		guard dismissedMentionAt != offset else { return nil }
		guard Mentions.canStart(at: at, in: text) else { return nil }
		let query = String(text[text.index(after: at)...])
		guard !query.contains("\n"), !query.hasPrefix(" "), !query.contains("@") else { return nil }
		let lowered = query.lowercased()
		let matches = mentionable.filter { $0.handle.contains(lowered) || $0.participant?.name.lowercased().contains(lowered) == true }
		return (at, query, matches)
	}

	/// The `:shortcode` being typed at the draft's end, two characters or more, and the emoji it could be.
	private var shortcodeBeingTyped: (start: String.Index, matches: [Emoji])? {
		guard let typed = text.firstMatch(of: /(?:^|[\s(]):([a-z0-9_+\-]{2,})$/.ignoresCase()) else { return nil }
		let matches = EmojiShortcodes.matching(String(typed.1))
		guard !matches.isEmpty else { return nil }
		return (text.index(typed.1.startIndex, offsetBy: -1), matches)
	}

	/// Turns a whole `:shortcode:` just typed into its emoji, as the web's composer does.
	private func completeShortcode(_ typed: String) {
		guard let closed = typed.firstMatch(of: /(?:^|[\s(]):([a-z0-9_+\-]+):$/.ignoresCase()),
			let emoji = EmojiShortcodes.named(String(closed.1))
		else { return }
		text = String(typed[..<typed.index(closed.1.startIndex, offsetBy: -1)]) + emoji.emoji
		EmojiShortcodes.remember(emoji)
	}

	private func choose(_ target: MentionTarget, replacing mention: (start: String.Index, query: String, matches: [MentionTarget])) {
		text = String(text[..<mention.start]) + "@\(target.handle) "
	}

	/// A file the person chose, read while its security scope is open.
	private static func read(_ url: URL) -> (name: String, contentType: String, data: Data)? {
		let scoped = url.startAccessingSecurityScopedResource()
		defer { if scoped { url.stopAccessingSecurityScopedResource() } }
		guard let data = try? Data(contentsOf: url) else { return nil }
		let type = UTType(filenameExtension: url.pathExtension)?.preferredMIMEType ?? "application/octet-stream"
		return (url.lastPathComponent, type, data)
	}
}

/// What the draft replies to, over the draft, with a × to stop replying.
private struct ReplyingToStrip: View {
	let replyTo: MessageReplyTo
	let cancel: () -> Void

	var body: some View {
		HStack(spacing: 8) {
			(Text("Replying to ") + Text(replyTo.author.name).fontWeight(.semibold).foregroundStyle(Palette.softForeground) + Text("  " + replyTo.preview))
				.font(Typeface.rubik(13))
				.foregroundStyle(Palette.mutedForeground)
				.lineLimit(1)
				.frame(maxWidth: .infinity, alignment: .leading)
			SmallIconButton(icon: .x, label: "Cancel reply", action: cancel).frame(width: 24, height: 24)
		}
		.padding(.vertical, 6)
		.padding(.leading, 12)
		.padding(.trailing, 6)
		.overlay(alignment: .bottom) { Rectangle().fill(Palette.border).frame(height: 1) }
	}
}

/// The files attached to the draft, each with how its upload is going and ×.
@MainActor
private struct AttachmentTray: View {
	let attachments: ComposerAttachments

	var body: some View {
		ScrollView(.horizontal, showsIndicators: false) {
			HStack(spacing: 6) {
				ForEach(attachments.items) { attachment in
					HStack(spacing: 8) {
						switch attachment.upload {
						case .uploading:
							ProgressView().controlSize(.mini)
						case .ready:
							Icon(.fileIcon, size: 14).foregroundStyle(Palette.softForeground)
						case let .failed(_, retryable):
							if retryable {
								Button { attachments.retry(attachment) } label: { Icon(.rotateCcw, size: 14) }
									.buttonStyle(.plain)
									.foregroundStyle(Palette.destructiveText)
									.accessibilityLabel("Retry \(attachment.name)")
							} else {
								Icon(.x, size: 14).foregroundStyle(Palette.destructiveText)
							}
						}
						VStack(alignment: .leading, spacing: 0) {
							Text(attachment.name).font(Typeface.rubik(12.5, .medium)).lineLimit(1).truncationMode(.middle)
							Text(note(attachment)).font(Typeface.rubik(11)).foregroundStyle(failed(attachment) ? Palette.destructiveText : Palette.subtleForeground)
						}
						.frame(maxWidth: 140, alignment: .leading)
						SmallIconButton(icon: .x, label: "Remove \(attachment.name)") { attachments.remove(attachment) }
					}
					.padding(.leading, 10)
					.padding(.trailing, 4)
					.padding(.vertical, 6)
					.background(Palette.card, in: RoundedRectangle(cornerRadius: 10, style: .continuous))
					.overlay(RoundedRectangle(cornerRadius: 10, style: .continuous).strokeBorder(Palette.border))
				}
			}
			.padding(8)
		}
	}

	private func failed(_ attachment: ComposerAttachment) -> Bool {
		if case .failed = attachment.upload { true } else { false }
	}

	private func note(_ attachment: ComposerAttachment) -> String {
		switch attachment.upload {
		case .uploading: "Uploading…"
		case let .ready(file): FileLook.sizeLabel(file.size)
		case let .failed(why, _): why
		}
	}
}

/// People and bots matching the `@` being typed, over the composer.
private struct SuggestionList: View {
	let matches: [MentionTarget]
	let choose: (MentionTarget) -> Void

	var body: some View {
		VStack(alignment: .leading, spacing: 0) {
			Text("Mention")
				.font(Typeface.rubik(12, .medium))
				.foregroundStyle(Palette.subtleForeground)
				.padding(.horizontal, 12)
				.padding(.top, 10)
				.padding(.bottom, 4)
			ScrollView {
				VStack(spacing: 0) {
					ForEach(matches, id: \.key) { target in
						Button { choose(target) } label: {
							HStack(spacing: 10) {
								if let member = target.participant {
									ParticipantFace(participant: member, size: 26)
								} else {
									Icon(.atSign, size: 14, strokeWidth: 2)
										.foregroundStyle(Palette.mutedForeground)
										.frame(width: 26, height: 26)
										.background(Palette.chip, in: Circle())
								}
								VStack(alignment: .leading, spacing: 1) {
									Text(target.participant?.name ?? "@\(target.handle)").font(Typeface.rubik(14, .medium)).foregroundStyle(Palette.foreground).lineLimit(1)
									Text(subtitle(target)).font(Typeface.rubik(12)).foregroundStyle(Palette.mutedForeground).lineLimit(1)
								}
								Spacer(minLength: 0)
							}
							.padding(.horizontal, 8)
							.padding(.vertical, 7)
							.contentShape(Rectangle())
						}
						.buttonStyle(PressableRowStyle(pressed: Palette.chip, cornerRadius: 6))
					}
				}
				.padding(.horizontal, 4)
				.padding(.bottom, 4)
			}
			.frame(maxHeight: 240)
			.fixedSize(horizontal: false, vertical: true)
		}
		.frame(width: 280)
		.background(Palette.panel, in: RoundedRectangle(cornerRadius: 8, style: .continuous))
		.overlay(RoundedRectangle(cornerRadius: 8, style: .continuous).strokeBorder(Palette.borderStrong))
		.shadow(color: .black.opacity(0.3), radius: 16, y: 6)
		.accessibilityElement(children: .contain)
		.accessibilityLabel("People and bots to mention")
	}

	/// Under a suggestion's name: Bot, a person's handle, or what mentioning everyone does.
	private func subtitle(_ target: MentionTarget) -> String {
		switch target {
		case .group: "Notify everyone who can see this"
		case .participant(.agent): "Bot"
		case let .participant(participant): "@\(participant.handle)"
		}
	}
}

/// Emoji matching the `:shortcode` being typed, over the composer.
private struct EmojiSuggestionList: View {
	let matches: [Emoji]
	let choose: (Emoji) -> Void

	var body: some View {
		VStack(alignment: .leading, spacing: 0) {
			Text("Emoji")
				.font(Typeface.rubik(12, .medium))
				.foregroundStyle(Palette.subtleForeground)
				.padding(.horizontal, 12)
				.padding(.top, 10)
				.padding(.bottom, 4)
			VStack(spacing: 0) {
				ForEach(matches, id: \.emoji) { emoji in
					Button { choose(emoji) } label: {
						HStack(spacing: 10) {
							Text(emoji.emoji).font(.system(size: 20)).frame(width: 26, height: 26)
							Text(":\(emoji.shortcodes.first ?? ""):").font(Typeface.rubik(14)).foregroundStyle(Palette.foreground).lineLimit(1)
							Spacer(minLength: 0)
						}
						.padding(.horizontal, 8)
						.padding(.vertical, 7)
						.contentShape(Rectangle())
					}
					.buttonStyle(PressableRowStyle(pressed: Palette.chip, cornerRadius: 6))
				}
			}
			.padding(.horizontal, 4)
			.padding(.bottom, 4)
		}
		.frame(width: 280)
		.background(Palette.panel, in: RoundedRectangle(cornerRadius: 8, style: .continuous))
		.overlay(RoundedRectangle(cornerRadius: 8, style: .continuous).strokeBorder(Palette.borderStrong))
		.shadow(color: .black.opacity(0.3), radius: 16, y: 6)
		.accessibilityElement(children: .contain)
		.accessibilityLabel("Emoji matching what was typed")
	}
}
